import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import * as crypto from 'crypto';
import { toWhatsAppAddress } from '../common/phone.util';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import {
  IssueType,
  WhatsAppFlowState,
} from './state/whatsapp-session.types';
import { PrismaService } from '../prisma/prisma.service';
import { RescueRequestStatus, UserRole, VehicleType, MediaType } from '@prisma/client';
import {
  getEligibleTruckClasses,
  mapVehicleTypeReply,
  formatVehicleType,
} from './domain/vehicle-truck-mapping';
import { estimateEtaMinutes, rankQuotes } from './domain/quote-ranking';
import {
  classifyMediaType,
  getExtensionFromContentType,
} from './domain/media-classification';
import { S3Service } from '../integrations/s3/s3.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import {
  RescueRequestListResponseDto,
  RescueRequestListItemDto,
  RescueRequestDetailResponseDto,
  RescueRequestDetailDto,
  PaginationMetaDto,
} from './dto/rescue-request-response.dto';

const DEPOSIT_AMOUNT_KOBO = 500000;   // ₦5,000

// ── Dispatch config ────────────────────────────────────────────────────────────
const BATCH_SIZE = 3;                  // operators offered per round simultaneously
const CUSTOMER_BUDGET_MINUTES = 10;   // max total customer wait before radius expands
const MIN_WINDOW_SECONDS = 90;        // floor: operators always get at least 90s
const MAX_WINDOW_SECONDS = 180;       // ceiling: never more than 3 min per batch
const DISPATCH_RETRY_MINUTES         = Number(process.env.DISPATCH_RETRY_MINUTES  ?? 5);   // set to 1 in dev
const MAX_FAILED_ROUNDS_BEFORE_ALERT = Number(process.env.DISPATCH_MAX_ALERT_ROUND ?? 2);
const MAX_ROUNDS_BEFORE_AUTO_CANCEL  = Number(process.env.DISPATCH_MAX_ROUNDS     ?? 4);   // ~RETRY*MAX min total
const RADIUS_EXPANSION_KM = 2;
const MAX_MEDIA_ITEMS = 5;

// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RescueRequestService {
  constructor(
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
    private readonly s3Service: S3Service,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  /**
   * In-memory map from rescueRequestId to the pending batch-window timer.
   * Doubles as a simple single-process mutex: whichever code path (the
   * timer firing, or an operator's response completing the batch early)
   * finds and deletes the entry first is the one that resolves the batch;
   * the other finds it already gone and returns immediately. Fine for a
   * single-instance pilot deployment — not a distributed lock.
   */
  private readonly batchTimers = new Map<string, NodeJS.Timeout>();

  /**
   * In-memory map from rescueRequestId to a short grace-period timer, started
   * the moment the FIRST quote in a batch arrives. If the rest of the batch
   * stays silent, we don't make the motorist wait out the full window for a
   * shortlist that already has a usable quote — resolveBatch fires early with
   * whatever's in by then (any still-PENDING offers are marked TIMED_OUT, same
   * as a normal window expiry). Guarded by the same batchTimers mutex inside
   * resolveBatch, so this is safe to fire even if the batch already resolved
   * some other way by the time it goes off.
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly QUOTE_GRACE_MS = 25 * 1000;

  // ═══════════════════════════════════════════════════════
  //  WHATSAPP FLOW — incoming message handler
  // ═══════════════════════════════════════════════════════

  async handleIncomingWhatsAppMessage(body: Record<string, any>) {
    // Twilio always delivers E.164 with country code — just strip the whatsapp: prefix
    const phoneNumber: string = String(body.From || '').replace(/^whatsapp:/i, '');
    const rawMessage = String(body.Body || '').trim();
    const message = rawMessage.toLowerCase();
    const latitude  = body.Latitude  ? Number(body.Latitude)  : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;

    console.log('Incoming WhatsApp message:', { phoneNumber, message, latitude, longitude });

    // Always resolve (or create) a User for this phone number.
    // Operators and customers both have a User record — this is our session key.
    const user = await this.findOrCreateCustomer(phoneNumber);
    const userId = user.id;

    const session = await this.sessionStore.getOrCreate(userId);

    // ── Route operator messages first ──────────────────────────────────────
    const operatorRecord = await this.prisma.operator.findUnique({
      where: { phoneNumber },
    });
    
    if (operatorRecord) {
      return this.handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord);
    }

    // ── CONFIRM / DISPUTE job completion (customer side) ──────────────────
    if (session.state === WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM) {
      if (message === 'confirm') {
        if (session.rescueRequestId) {
          await this.markJobCompleted(session.rescueRequestId);
          await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
        }
        return this.xmlOk();
      }
      if (message === 'dispute') {
        // Notify admin and hold the request — do not auto-complete
        await this.alertAdminNoOperator(session.rescueRequestId ?? '', 0, 0, -1); // reuse alert channel
        await this.twilioService.sendWhatsAppMessage(
          phoneNumber,
          `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.\n\nDo NOT release the vehicle until you hear from us.`,
        );
        return this.xmlOk();
      }
      // Any other message — remind them what to do
      return this.reply(
        `Your operator says the job is done. Reply *CONFIRM* to release the vehicle and receive your balance payment link, or *DISPUTE* if there's a problem.`,
      );
    }

    // ── SOS / new request ──────────────────────────────────────────────────
    if (this.isSosMessage(message)) {
      // Duplicate SOS detection — check for existing open request
      {
        const openRequest = await this.prisma.rescueRequest.findFirst({
          where: {
            customerId: userId,
            status: {
              notIn: [
                RescueRequestStatus.COMPLETED,
                RescueRequestStatus.CANCELLED,
              ] as RescueRequestStatus[],
            },
          },
        });
        if (openRequest && openRequest.status === RescueRequestStatus.WAITING_FOR_MEDIA) {
          // Stale request abandoned before any media was sent — nothing else expires it,
          // so auto-cancel it and let the new SOS proceed normally.
          await this.prisma.rescueRequest.update({
            where: { id: openRequest.id },
            data: { status: RescueRequestStatus.CANCELLED },
          });
        } else if (openRequest) {
          return this.reply(
            `⚠️ You already have an active rescue request (${this.formatStatus(openRequest.status)}).\n\nWe're on it! Reply CANCEL to cancel the current request.`,
          );
        }
      }

      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.WAITING_FOR_LOCATION,
        latitude: undefined,
        longitude: undefined,
        issueType: undefined,
        rescueRequestId: undefined,
        depositReference: undefined,
        dispatchRound: 0,
        offeredOperatorIds: [],
      });

      return this.reply(
        `🚨 LRR Rescue here. Please share your current location pin so we can find the nearest tow operator.`,
      );
    }

    // ── CANCEL active request ──────────────────────────────────────────────
    if (message === 'cancel') {
      // Primary path: rescueRequestId stored in session
      let requestIdToCancel = session.rescueRequestId;

      // Fallback: session may have lost state (server restart, previous session cleared
      // before request was created, etc.) — look up the open request in the DB directly
      if (!requestIdToCancel) {
        const openRequest = await this.prisma.rescueRequest.findFirst({
          where: {
            customerId: userId,
            status: {
              notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] as RescueRequestStatus[],
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (openRequest) requestIdToCancel = openRequest.id;
      }

      if (requestIdToCancel) {
        const existing = await this.prisma.rescueRequest.findUnique({
          where: { id: requestIdToCancel },
          include: { assignedOperator: true },
        });

        await this.prisma.rescueRequest.update({
          where: { id: requestIdToCancel },
          data: { status: RescueRequestStatus.CANCELLED },
        });
        await this.sessionStore.clear(userId);

        // If an operator was tentatively holding this job (awaiting customer payment),
        // release them and let them know
        if (
          existing?.status === RescueRequestStatus.WAITING_FOR_DEPOSIT &&
          existing.assignedOperator
        ) {
          await this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(existing.assignedOperator.phoneNumber),
            `❌ The customer cancelled before confirming payment. You have been released. Watch out for new offers!`,
          );
        }

        return this.reply(`❌ Your rescue request has been cancelled. You were not charged.\n\nSend SOS or HELP if you need assistance again.`);
      }

      // Nothing to cancel
      return this.reply(`You don't have an active rescue request to cancel.\n\nSend SOS or HELP if you need assistance.`);
    }

    // ── Step 1: Waiting for location ───────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_LOCATION) {
      if (!latitude || !longitude) {
        return this.reply(
          `📍 Please share your location using WhatsApp's location pin — not a typed address.`,
        );
      }
      await this.sessionStore.update(userId, {
        latitude,
        longitude,
        state: WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE,
      });
      return this.reply(
        `📍 Location received!\n\nWhat type of vehicle is it?\n\n1️⃣ Sedan\n2️⃣ SUV\n3️⃣ Armored/Luxury\n4️⃣ Heavy Trailer`,
      );
    }

    // ── Step 2: Waiting for vehicle type ───────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE) {
      const vehicleType = mapVehicleTypeReply(message);
      if (!vehicleType) {
        return this.reply(`Please reply with a number 1-4 to select the vehicle type.`);
      }
      await this.sessionStore.update(userId, {
        vehicleType,
        state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      });
      return this.reply(
        `🚗 ${formatVehicleType(vehicleType)} noted!\n\nWhere would you like the car towed to? (e.g. a workshop name or address)`,
      );
    }

    // ── Step 3: Waiting for destination ────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_DESTINATION) {
      const destination = rawMessage;
      if (!destination) {
        return this.reply(`Please type where you'd like the car towed to.`);
      }

      const customer = await this.findOrCreateCustomer(phoneNumber);
      const rescueRequest = await this.prisma.rescueRequest.create({
        data: {
          customerId:  customer.id,
          status:      RescueRequestStatus.WAITING_FOR_MEDIA,
          latitude:    session.latitude,
          longitude:   session.longitude,
          vehicleType: session.vehicleType as VehicleType,
          destination,
        },
      });

      await this.sessionStore.update(userId, {
        destination,
        rescueRequestId: rescueRequest.id,
        state: WhatsAppFlowState.WAITING_FOR_MEDIA,
      });
      return this.reply(
        `📍 Got it!\n\nPlease send at least one *photo or video* of the vehicle/breakdown (voice notes welcome too, but a photo or video is required).`,
      );
    }

    // ── Step 3b: Waiting for media ─────────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_MEDIA) {
      const rescueRequestId = session.rescueRequestId;
      if (!rescueRequestId) {
        await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE });
        return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
      }

      if (message === '2') {
        const visualCount = await this.prisma.requestMedia.count({
          where: { rescueRequestId, mediaType: { in: [MediaType.IMAGE, MediaType.VIDEO] } },
        });
        if (visualCount === 0) {
          return this.reply(
            `Please send at least one photo or video before continuing — a voice note alone isn't enough for the operator to assess the vehicle.`,
          );
        }
        return this.handleMediaFinished(phoneNumber, userId, session, rescueRequestId);
      }

      if (message === '1') {
        return this.reply(`Go ahead — send your photo(s), video(s), or voice note(s).`);
      }

      const numMedia = Number(body.NumMedia ?? 0);
      if (numMedia === 0) {
        return this.reply(
          `Please send at least one photo or video (voice notes welcome too).\n\n1️⃣ Add more\n2️⃣ Continue to dispatch`,
        );
      }

      const existingCount = await this.prisma.requestMedia.count({ where: { rescueRequestId } });
      let savedCount = existingCount;
      let failedCount = 0;
      let capReached = false;

      for (let i = 0; i < numMedia; i++) {
        if (savedCount >= MAX_MEDIA_ITEMS) {
          capReached = true;
          break;
        }

        const mediaUrl: string | undefined = body[`MediaUrl${i}`];
        const contentType: string | undefined = body[`MediaContentType${i}`];
        if (!mediaUrl || !contentType) continue;

        const saved = await this.captureMediaAttachment(rescueRequestId, mediaUrl, contentType);
        if (saved) {
          savedCount++;
        } else {
          failedCount++;
        }
      }

      const capNote = capReached
        ? `\n\n⚠️ You've reached the ${MAX_MEDIA_ITEMS}-item limit — further attachments won't be saved.`
        : '';
      const failNote = failedCount > 0
        ? `\n\n⚠️ ${failedCount} item(s) failed to upload — please resend if important.`
        : '';

      return this.reply(
        `📸 Received (${savedCount}/${MAX_MEDIA_ITEMS} items saved).${capNote}${failNote}\n\n1️⃣ Add more\n2️⃣ Continue to dispatch`,
      );
    }

    // ── Step 3c: Waiting for quote selection ───────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION) {
      const choice = Number(message);
      if (!Number.isInteger(choice) || choice < 1) {
        return this.reply(`Please reply with the number of the quote you'd like to choose.`);
      }
      return this.handleQuoteSelected(phoneNumber, userId, choice);
    }

    // ── Step 3: Operator found — waiting for customer to pay ──────────────
    if (session.state === WhatsAppFlowState.OPERATOR_FOUND_WAITING_PAYMENT) {
      return this.reply(
        `🚗 An operator is standing by for you! Please pay using the link we sent you to confirm.\n\nYou have 5 minutes or the slot will be released.\n\nReply CANCEL to cancel (you will not be charged).`,
      );
    }

    // ── Step 4: Request active — searching for operator ───────────────────
    if (session.state === WhatsAppFlowState.REQUEST_CONFIRMED) {
      return this.reply(
        `🔍 We've received your request and are searching for the nearest operator.\n\nYou will be notified once one is confirmed. Reply CANCEL to cancel (no charge).`,
      );
    }

    return this.reply(
      `👋 Welcome to Lagos Roadside Rescue.\n\nSend HELP or SOS if you need roadside assistance.`,
    );
  }

  /**
   * Downloads one Twilio media attachment, uploads it to S3, and creates the
   * RequestMedia row. Returns false (rather than throwing) on any failure —
   * a single bad attachment must not break the rest of the batch or the flow.
   */
  private async captureMediaAttachment(
    rescueRequestId: string,
    mediaUrl: string,
    contentType: string,
  ): Promise<boolean> {
    const mediaType = classifyMediaType(contentType);
    if (!mediaType) return false;

    try {
      const buffer = await this.twilioService.downloadMedia(mediaUrl);
      const extension = getExtensionFromContentType(contentType);
      const s3Key = `rescue-requests/${rescueRequestId}/${crypto.randomUUID()}.${extension}`;

      await this.s3Service.uploadMedia(buffer, contentType, s3Key);

      await this.prisma.requestMedia.create({
        data: { rescueRequestId, mediaType, s3Key, contentType },
      });

      return true;
    } catch (error) {
      console.error('Failed to capture media attachment:', error);
      Sentry.captureException(error);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Operator message router
  // ──────────────────────────────────────────────────────────────────────────
  private async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // ── Dispatch quote / decline ─────────────────────────────────────────
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(message) * 100);
    }

    // ── ARRIVED at customer location ───────────────────────────────────────
    if (message === 'arrived' || message === 'on site' || message === 'onsite') {
      if (session.state !== WhatsAppFlowState.OPERATOR_ON_JOB || !session.rescueRequestId) {
        return this.reply(`You don't have an active job. Wait for a dispatch offer.`);
      }
      return this.handleOperatorArrived(phoneNumber, userId, session.rescueRequestId, operator);
    }

    // ── Job DONE — prompt customer to confirm ──────────────────────────────
    if (message === 'done' || message === 'complete' || message === 'finished') {
      if (session.state !== WhatsAppFlowState.OPERATOR_AT_LOCATION || !session.rescueRequestId) {
        return this.reply(`Please send ARRIVED first when you reach the customer location.`);
      }
      return this.handleOperatorJobDone(phoneNumber, userId, session.rescueRequestId, operator);
    }

    // ── Contextual help ───────────────────────────────────────────────────
    if (session.state === WhatsAppFlowState.OPERATOR_ON_JOB) {
      return this.reply(
        `📍 Send *ARRIVED* when you reach the customer location so we can notify them.`,
      );
    }
    if (session.state === WhatsAppFlowState.OPERATOR_AT_LOCATION) {
      return this.reply(
        `✅ Send *DONE* when the job is complete. The customer will confirm and you'll both be notified.`,
      );
    }

    return this.xmlOk();
  }

  /**
   * Channel-agnostic core: an operator submitted a price (quote) or declined
   * a specific PENDING offer. `quotedPriceKobo` is undefined for a decline.
   * Used by both the WhatsApp reply handler below and the dashboard quote
   * endpoint (Task 12) — the only thing that differs between channels is how
   * the caller resolves `offer` in the first place.
   */
  private async processQuoteOrDecline(
    offer: { id: string; rescueRequestId: string; expiresAt: Date },
    quotedPriceKobo: number | undefined,
  ): Promise<{ quoted: boolean; message: string }> {
    if (quotedPriceKobo === undefined) {
      await this.prisma.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);
      return { quoted: false, message: `Understood. We'll offer this job to another operator.` };
    }

    await this.prisma.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: 'QUOTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
    });
    await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);
    this.scheduleGraceResolve(offer.rescueRequestId, offer.expiresAt);

    return {
      quoted: true,
      message: `✅ Quote of ₦${(quotedPriceKobo / 100).toLocaleString()} submitted! We'll notify you if you're selected.`,
    };
  }

  /**
   * Starts (once per batch) the QUOTE_GRACE_MS countdown after a batch's
   * first quote arrives. If nothing else has resolved the batch by then,
   * forces resolution with whatever quotes exist rather than making the
   * motorist wait out the rest of the full window for silent operators.
   */
  private scheduleGraceResolve(rescueRequestId: string, batchExpiresAt: Date) {
    if (this.graceTimers.has(rescueRequestId)) return; // already scheduled for this batch

    const timer = setTimeout(async () => {
      this.graceTimers.delete(rescueRequestId);
      const batchOffers = await this.prisma.dispatchOffer.findMany({
        where: { rescueRequestId, expiresAt: batchExpiresAt },
        select: { operatorId: true },
      });
      const rescueRequest = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { customerId: true },
      });
      if (!rescueRequest) return;

      // extraRadiusKm is 0 here for the same reason maybeResolveBatchEarly uses
      // 0 — a grace-forced resolve already has at least one quote, so it never
      // needs a radius expansion to find candidates.
      void this.resolveBatch(rescueRequestId, batchOffers.map((o) => o.operatorId), rescueRequest.customerId, 0);
    }, this.QUOTE_GRACE_MS);

    this.graceTimers.set(rescueRequestId, timer);
  }

  /**
   * Operator replied to a dispatch offer with either a price (quote) or NO
   * (decline) over WhatsApp. `quotedPriceKobo` is undefined for a decline.
   */
  private async handleOperatorQuoteOrDecline(
    operatorPhone: string,
    operatorUserId: string,
    quotedPriceKobo: number | undefined,
  ) {
    const operator = await this.prisma.operator.findUnique({
      where: { phoneNumber: operatorPhone },
    });
    if (!operator) return this.xmlOk();

    const offer = await this.prisma.dispatchOffer.findFirst({
      where: { operatorId: operator.id, status: 'PENDING' },
      orderBy: { offeredAt: 'desc' },
    });
    if (!offer) return this.xmlOk();

    const result = await this.processQuoteOrDecline(offer, quotedPriceKobo);
    return this.reply(result.message);
  }

  private async handleOperatorArrived(
    operatorPhone: string,
    operatorUserId: string,
    rescueRequestId: string,
    operator: { id: string; businessName: string },
  ) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest || rescueRequest.status === RescueRequestStatus.CANCELLED || rescueRequest.status === RescueRequestStatus.COMPLETED) {
      await this.sessionStore.clear(operatorUserId);
      return this.reply(`This job has already ended. Watch out for new dispatch offers.`);
    }

    // Update request status to ARRIVED
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.ARRIVED },
    });

    // Operator session → AT_LOCATION
    await this.sessionStore.update(operatorUserId, {
      state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
    });

    // Notify customer
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 Your tow operator has arrived!\n\nBusiness: *${operator.businessName}*\n\nThey're at your location. Please show them your vehicle.`,
      );
    }

    return this.reply(`✅ Arrival confirmed! The customer has been notified.\n\nSend *DONE* when the job is complete.`);
  }

  private async handleOperatorJobDone(
    operatorPhone: string,
    operatorUserId: string,
    rescueRequestId: string,
    operator: { id: string; businessName: string },
  ) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest || rescueRequest.status === RescueRequestStatus.CANCELLED || rescueRequest.status === RescueRequestStatus.COMPLETED) {
      await this.sessionStore.clear(operatorUserId);
      return this.reply(`This job has already ended.`);
    }

    const customerPhone = rescueRequest.customer.phoneNumber;
    const customerId    = rescueRequest.customerId;

    // Put customer session in AWAITING_COMPLETION_CONFIRM
    if (customerId) {
      await this.sessionStore.update(customerId, {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId,
      });
    }
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🔧 ${operator.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
      );
    }

    // Auto-complete after 30 minutes if customer doesn't respond
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh && fresh.status !== RescueRequestStatus.COMPLETED && fresh.status !== RescueRequestStatus.CANCELLED) {
        console.log(`⏱ Auto-completing request ${rescueRequestId} — customer did not confirm in 30 min`);
        await this.markJobCompleted(rescueRequestId);
        await this.sessionStore.update(customerId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, 30 * 60 * 1000);

    await this.sessionStore.update(operatorUserId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });

    return this.reply(
      `✅ Job marked as done! Waiting for customer confirmation.\n\nIf they confirm, you'll receive a notification. Thank you 🙏`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Media capture finished → subscriber check → deposit or direct dispatch
  // ──────────────────────────────────────────────────────────────────────────
  private async handleMediaFinished(
    phoneNumber: string,
    userId: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    rescueRequestId: string,
  ) {
    const [customer, rescueRequestRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.rescueRequest.findUnique({ where: { id: rescueRequestId } }),
    ]);
    if (!customer || !rescueRequestRow) {
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }
    const vehicleType = rescueRequestRow.vehicleType as VehicleType;
    const destination = rescueRequestRow.destination as string;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.DISPATCHING },
    });

    await this.sessionStore.update(userId, {
      state:              WhatsAppFlowState.REQUEST_CONFIRMED,
      dispatchRound:      0,
      offeredOperatorIds: [],
    });

    const greet = customer.name ? `Hi ${customer.name.split(' ')[0]}! ` : '';
    await this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `${greet}🔍 Searching for nearby tow operators...\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\n\nOperators will submit their price and ETA — you'll get a shortlist to choose from shortly. Reply CANCEL at any time.`,
    );

    void this.startDispatch(rescueRequestId, customer.id);
    return this.xmlOk();
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  Create rescue request + Paystack link
  // ──────────────────────────────────────────────────────────────────────────
  private async initiateDeposit(
    customer: any,
    session: any,
    issueType: IssueType,
    phoneNumber: string,
    prefixNote: string | null,
    amountKobo: number,
  ) {
    const rescueRequest = await this.prisma.rescueRequest.create({
      data: {
        customerId:    customer.id,
        status:        RescueRequestStatus.WAITING_FOR_DEPOSIT,
        latitude:      session.latitude,
        longitude:     session.longitude,
        issueType,
        depositAmount: amountKobo,
      },
    });

    const reference = this.paystackService.generateReference('DEP');
    const email = customer.email || `${phoneNumber.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: amountKobo,
      reference,
      metadata: {
        rescueRequestId: rescueRequest.id,
        customerId:      customer.id,
        phoneNumber,
        type: 'deposit',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to initialize Paystack payment:', paymentResponse);
      return this.reply(`Sorry, we couldn't create a payment link. Please try again.`);
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositReference: reference },
    });

    await this.sessionStore.update(customer.id, {
      issueType,
      rescueRequestId:  rescueRequest.id,
      depositReference: reference,
      state:            WhatsAppFlowState.WAITING_FOR_DEPOSIT,
    });

    const isStandardDeposit = amountKobo === DEPOSIT_AMOUNT_KOBO;
    const note = prefixNote ? `\n\n${prefixNote}` : '';

    const costBreakdown = isStandardDeposit
      ? `💰 *Total cost: ₦50,000*\n   • ₦5,000 deposit now (holds your slot)\n   • ₦45,000 balance on job completion — car released after payment\n`
      : `💰 *One-time fee: ₦50,000* (paid in full now)\n`;

    return this.reply(
      `Issue: ${this.formatIssueType(issueType)}${note}\n\n${costBreakdown}\nPay ${isStandardDeposit ? '₦5,000 deposit' : '₦50,000'} to confirm your rescue:\n\n${paymentResponse.data.authorization_url}\n\n⏱ Slot held for 5 minutes.`,
    );
  }

  // ══════════════════════════════════════════════════════
  //  DEPOSIT CONFIRMED (webhook)
  // ══════════════════════════════════════════════════════

  async handleDepositPaymentConfirmed(reference: string) {
    console.log('🔍 Deposit confirmed, reference:', reference);

    const rescueRequest = await this.prisma.rescueRequest.findFirst({
      where:   { depositReference: reference },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) {
      console.error('❌ No rescue request for deposit reference:', reference);
      Sentry.captureMessage(`Deposit webhook: no request found for reference ${reference}`, 'error');
      return;
    }

    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;

    // Mark deposit paid and fully confirm the operator assignment
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
    });

    // The offer is only actually awarded now that payment is confirmed —
    // selection alone (Task 8) only reached SELECTED_PENDING_PAYMENT.
    if (rescueRequest.assignedOperatorId) {
      await this.prisma.dispatchOffer.updateMany({
        where: {
          rescueRequestId: rescueRequest.id,
          operatorId: rescueRequest.assignedOperatorId,
          status: 'SELECTED_PENDING_PAYMENT',
        },
        data: { status: 'ACCEPTED' },
      });
    }

    const operator = rescueRequest.assignedOperator;

    // Customer: confirmed with operator details
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.REQUEST_CONFIRMED,
    });
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        operator
          ? `✅ *Payment confirmed — operator is on the way!*\n\nBusiness: ${operator.businessName}\nPhone: ${operator.phoneNumber}\n\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}\n\nYou'll be notified when they arrive.`
          : `✅ Deposit confirmed! Finding the nearest tow operator...`,
      );
    }

    if (operator) {
      // Operator: job is now live — send customer location + details
      const opUser = await this.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state:           WhatsAppFlowState.OPERATOR_ON_JOB,
        rescueRequestId: rescueRequest.id,
      });
      const lat = rescueRequest.latitude;
      const lon = rescueRequest.longitude;
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💰 *Payment confirmed — job is live!*\n\nCustomer: ${customerPhone}\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}\nLocation: https://maps.google.com/?q=${lat},${lon}\n\nHead over now and send *ARRIVED* when you reach them.`,
      );
    } else {
      // Edge case: no operator was pre-assigned (e.g. admin manually sent a payment link)
      void this.startDispatch(rescueRequest.id, customerId);
    }
  }

  // ══════════════════════════════════════════════════════
  //  BALANCE CONFIRMED (webhook)
  // ══════════════════════════════════════════════════════

  async handleBalancePaymentConfirmed(reference: string) {
    console.log('💰 Balance confirmed, reference:', reference);

    const rescueRequest = await this.prisma.rescueRequest.findFirst({
      where: { balanceReference: reference },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) {
      console.error('❌ No rescue request for balance reference:', reference);
      Sentry.captureMessage(`Balance webhook: no request found for reference ${reference}`, 'error');
      return;
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { balancePaid: true, status: RescueRequestStatus.COMPLETED },
    });

    // Notify customer — payment confirmed
    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      const balanceNaira = ((rescueRequest.balanceAmount ?? 0) / 100).toLocaleString();
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Lagos Roadside Rescue 🙏`,
      );
    }
    // Clear customer session
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.IDLE,
      rescueRequestId: undefined,
    });

    // Notify operator — release the vehicle
    const operator = rescueRequest.assignedOperator;
    if (operator?.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💵 *Payment received!*\n\nThe customer has paid the ₦45,000 balance in full.\n\n✅ You may now *release the vehicle*. Job complete — well done!\n\nYour payment will be remitted within 24 hours.`,
      );
      // Clear operator session
      const opUser = await this.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
    }

    console.log(`✅ Job ${rescueRequest.id} completed — operator and customer notified`);
  }

  // ══════════════════════════════════════════════════════
  //  DISPATCH — parallel batch offer, dynamic window, retry + radius expansion
  // ══════════════════════════════════════════════════════

  async startDispatch(
    rescueRequestId: string,
    customerId: string,
    extraRadiusKm: number = 0,
  ) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest) return;
    if (
      rescueRequest.status === RescueRequestStatus.CANCELLED ||
      rescueRequest.status === RescueRequestStatus.COMPLETED ||
      rescueRequest.status === RescueRequestStatus.OPERATOR_ASSIGNED ||
      rescueRequest.status === RescueRequestStatus.WAITING_FOR_DEPOSIT  // payment window active
    ) return;

    // Resolve the customer's phone number for Twilio messages
    const customerRecord = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: { phoneNumber: true },
    });
    const customerPhone = customerRecord?.phoneNumber ?? null;

    const session = await this.sessionStore.getOrCreate(customerId);
    const alreadyOffered: string[] = session.offeredOperatorIds ?? [];
    const round = session.dispatchRound ?? 0;

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);

    const eligibleTruckClasses = rescueRequest.vehicleType
      ? getEligibleTruckClasses(rescueRequest.vehicleType as VehicleType)
      : undefined;

    // Get all ranked candidates (excluding already-offered operators)
    const candidates = await this.operatorService.findAndRankCandidates(
      lat, lon, alreadyOffered, extraRadiusKm, undefined, eligibleTruckClasses,
    );

    if (candidates.length === 0) {
      // Fast-fail: check if there are ANY active operators near this location
      // (ignoring isAvailable — counts busy ones too).
      // If zero, it's a geography/coverage gap — retrying with an expanded
      // radius won't help, so cancel immediately rather than making the
      // customer wait 15-20 minutes for the same result.
      //
      // ~1.5° ≈ 150 km bounding box — larger than any realistic service radius,
      // so this covers the maximum possible expansion area upfront.
      const COVERAGE_DELTA_DEG = 1.5;
      const nearbyOperatorCount = await this.prisma.operator.count({
        where: {
          status: 'ACTIVE',           // isAvailable intentionally omitted
          latitude:  { gte: lat - COVERAGE_DELTA_DEG, lte: lat + COVERAGE_DELTA_DEG },
          longitude: { gte: lon - COVERAGE_DELTA_DEG, lte: lon + COVERAGE_DELTA_DEG },
        },
      });

      if (nearbyOperatorCount === 0) {
        // No operator infrastructure in this area at all — cancel immediately
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data:  { status: RescueRequestStatus.CANCELLED },
        });
        await this.sessionStore.clear(customerId);
        if (customerPhone) {
          await this.twilioService.sendWhatsAppMessage(
            customerPhone,
            `😔 Sorry, there are no tow operators available in your area at the moment.\n\nYour request has been cancelled and *you have not been charged*.\n\nPlease try again later or call your breakdown provider.`,
          );
        }
        await this.alertAdminNoOperator(rescueRequestId, lat, lon, 0);
        return;
      }

      // Operators exist in the area but are currently busy or offline —
      // proceed with the normal retry + radius-expansion cycle.
      const newRound = round + 1;
      // Reset offeredOperatorIds so timed-out operators can be re-offered
      // after the retry delay — they may have missed the first notification
      await this.sessionStore.update(customerId, {
        dispatchRound: newRound,
        offeredOperatorIds: [],
      });

      if (newRound >= MAX_ROUNDS_BEFORE_AUTO_CANCEL) {
        // Tried long enough — auto-cancel the request and notify everyone
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { status: RescueRequestStatus.CANCELLED },
        });
        await this.sessionStore.clear(customerId);

        if (customerPhone) {
          await this.twilioService.sendWhatsAppMessage(
            customerPhone,
            `😔 We're sorry — no tow operator was available near you after an extended search.\n\nYour request has been automatically cancelled and *you were not charged*.\n\nPlease try again shortly or call your breakdown cover provider.`,
          );
        }

        await this.alertAdminNoOperator(rescueRequestId, lat, lon, newRound);
        console.warn(`🚨 Auto-cancelled request ${rescueRequestId} after ${newRound} rounds with no operator found.`);
        Sentry.withScope((scope) => {
          scope.setLevel('warning');
          scope.setContext('dispatch', { rescueRequestId, lat, lon, rounds: newRound });
          Sentry.captureMessage(`Auto-cancelled: no operator after ${newRound} rounds`);
        });
        return;
      }

      if (newRound > MAX_FAILED_ROUNDS_BEFORE_ALERT) {
        await this.alertAdminNoOperator(rescueRequestId, lat, lon, newRound);
      }

      if (customerPhone) {
        await this.twilioService.sendWhatsAppMessage(
          customerPhone,
          `⏳ Still searching for a tow operator nearby (attempt ${newRound}/${MAX_ROUNDS_BEFORE_AUTO_CANCEL - 1}). Expanding the search area. Thank you for your patience.`,
        );
      }

      const expandedRadius = extraRadiusKm + RADIUS_EXPANSION_KM;
      setTimeout(
        () => void this.startDispatch(rescueRequestId, customerId, expandedRadius),
        DISPATCH_RETRY_MINUTES * 60 * 1000,
      );
      return;
    }

    // Take the next batch of top-ranked candidates
    const batch = candidates.slice(0, BATCH_SIZE);
    const batchOperatorIds = batch.map((op) => op.id);

    // Dynamic window: spread customer budget evenly across expected batches
    const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
    const windowSeconds = Math.min(
      MAX_WINDOW_SECONDS,
      Math.max(MIN_WINDOW_SECONDS, Math.floor((CUSTOMER_BUDGET_MINUTES * 60) / totalBatches)),
    );

    const expiresAt = new Date(Date.now() + windowSeconds * 1000);

    // Create all offers in one batch insert
    await this.prisma.dispatchOffer.createMany({
      data: batch.map((op) => ({
        rescueRequestId,
        operatorId: op.id,
        expiresAt,
      })),
    });

    // Track offered operators in session
    await this.sessionStore.update(customerId, {
      offeredOperatorIds: [...alreadyOffered, ...batchOperatorIds],
      dispatchRound: round,
    });

    const vehicleLabel = rescueRequest.vehicleType
      ? formatVehicleType(rescueRequest.vehicleType as VehicleType)
      : 'Unknown';
    const destinationLabel = rescueRequest.destination ?? 'Not specified';

    const mediaItems = await this.prisma.requestMedia
      .findMany({
        where: { rescueRequestId },
      })
      .catch((error) => {
        console.error('Failed to fetch media for dispatch offer:', error);
        Sentry.captureException(error);
        return [];
      });
    const mediaSection = this.buildMediaLinksSection(mediaItems);

    // Notify all batch operators simultaneously
    await Promise.all(
      batch.map((op) =>
        this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(op.phoneNumber),
          `🚨 *NEW RESCUE JOB*\n\nVehicle: ${vehicleLabel}\nDestination: ${destinationLabel}\nDistance: ${op.distance.toFixed(1)} km\nLocation: https://maps.google.com/?q=${lat},${lon}${mediaSection}\n\n💰 Reply with your price to bid, e.g. "25000".\nEst. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.\nReply *NO* to decline.\nYou have ${windowSeconds} seconds.`,
        ),
      ),
    );

    // Single timeout covers the entire batch — stored so an early-resolved
    // batch (Step below) can prevent this from firing a second time.
    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm),
      windowSeconds * 1000,
    );
    this.batchTimers.set(rescueRequestId, timer);
  }

  private async resolveBatch(
    rescueRequestId: string,
    batchOperatorIds: string[],
    customerId: string,
    extraRadiusKm: number,
  ) {
    // Mutex: only the caller that finds (and removes) the timer entry proceeds.
    const timer = this.batchTimers.get(rescueRequestId);
    if (!timer) return; // already resolved by the other path
    clearTimeout(timer);
    this.batchTimers.delete(rescueRequestId);

    // This batch is resolving now — no need for a pending grace timer to fire later.
    const graceTimer = this.graceTimers.get(rescueRequestId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(rescueRequestId);
    }

    // Race condition guard — skip if the request moved on for any other reason
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { status: true },
    });
    if (
      !rescueRequest ||
      rescueRequest.status === RescueRequestStatus.OPERATOR_ASSIGNED ||
      rescueRequest.status === RescueRequestStatus.WAITING_FOR_DEPOSIT ||
      rescueRequest.status === RescueRequestStatus.COMPLETED ||
      rescueRequest.status === RescueRequestStatus.CANCELLED
    ) return;

    // Mark all still-pending offers in this batch as timed out
    await this.prisma.dispatchOffer.updateMany({
      where: {
        rescueRequestId,
        operatorId: { in: batchOperatorIds },
        status: 'PENDING',
      },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
    });

    if (quotedOffers.length > 0) {
      await this.sendQuoteShortlist(rescueRequestId, customerId);
      return;
    }

    // No quotes at all this round — move to next batch (same radius; untried
    // operators may still be available), exactly as before.
    void this.startDispatch(rescueRequestId, customerId, extraRadiusKm);
  }

  /**
   * Called after each operator quote/decline. If every operator in the
   * current batch has now responded, resolves the batch immediately instead
   * of waiting out the rest of the window.
   */
  private async maybeResolveBatchEarly(rescueRequestId: string, batchExpiresAt: Date) {
    const batchOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, expiresAt: batchExpiresAt },
      select: { operatorId: true, status: true },
    });
    const stillPending = batchOffers.some((o) => o.status === 'PENDING');
    if (stillPending) return;

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { customerId: true },
    });
    if (!rescueRequest) return;

    const batchOperatorIds = batchOffers.map((o) => o.operatorId);
    // extraRadiusKm isn't tracked per-batch outside the session; 0 is correct
    // here because an early-resolved batch (all responded) never needed a
    // radius expansion to find candidates — expansion only happens when
    // zero candidates exist at all, a separate path in startDispatch.
    void this.resolveBatch(rescueRequestId, batchOperatorIds, rescueRequest.customerId, 0);
  }

  private readonly QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;

  private async sendQuoteShortlist(rescueRequestId: string, customerId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) return;

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
      include: { operator: true },
    });
    if (quotedOffers.length === 0) return;

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);

    const forRanking = quotedOffers.map((offer) => {
      const distance = this.operatorService['calculateDistance'](
        lat, lon, Number(offer.operator.latitude), Number(offer.operator.longitude),
      );
      return {
        offerId: offer.id,
        operatorId: offer.operatorId,
        businessName: offer.operator.businessName,
        quotedPrice: offer.quotedPrice!,
        etaMinutes: estimateEtaMinutes(distance),
      };
    });

    const ranked = rankQuotes(forRanking); // ranks by raw quotedPrice — markup is a uniform % and never changes order

    const config = await this.platformConfigService.getConfig();
    const lines = ranked.map((q, i) => {
      const numberEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i] ?? `${i + 1}.`;
      // Motorist-facing amount is ALWAYS quotedPrice + service fee — never the raw quote.
      // This must exactly match what handleQuoteSelected (Task 8) later charges, so the
      // motorist never sees one number here and a different one at payment.
      const displayTotal = q.quotedPrice + Math.round((q.quotedPrice * config.serviceFeePercent) / 100);
      const priceNaira = (displayTotal / 100).toLocaleString();
      return `${numberEmoji} ₦${priceNaira} · ETA ${q.etaMinutes} min · ${q.businessName}`;
    });

    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 *Operator quotes received!*\n\n${lines.join('\n')}\n\nReply with the number of your choice.`,
      );
    }

    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION,
    });

    setTimeout(async () => {
      const fresh = await this.sessionStore.getOrCreate(customerId);
      if (fresh.state !== WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION) return; // already selected

      // Timed out — release every quoting operator and let the motorist retry.
      await this.prisma.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'QUOTED' },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      await this.sessionStore.clear(customerId);

      if (customerPhone) {
        await this.twilioService.sendWhatsAppMessage(
          customerPhone,
          `⏰ You didn't choose a quote in time. Your request has been cancelled — send SOS to start again.`,
        );
      }
      await Promise.all(
        quotedOffers.map((offer) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(offer.operator.phoneNumber),
            `⏰ The customer didn't respond in time. You've been released. Watch for new offers!`,
          ),
        ),
      );
    }, this.QUOTE_SELECTION_WINDOW_MS);
  }

  private async handleQuoteSelected(phoneNumber: string, userId: string, choice: number) {
    const session = await this.sessionStore.getOrCreate(userId);
    const rescueRequestId = session.rescueRequestId;
    if (!rescueRequestId) {
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) {
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
      include: { operator: true },
    });
    if (quotedOffers.length === 0) {
      return this.reply(`Sorry, those quotes are no longer available.`);
    }

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);
    const forRanking = quotedOffers.map((offer) => ({
      offerId: offer.id,
      operatorId: offer.operatorId,
      businessName: offer.operator.businessName,
      quotedPrice: offer.quotedPrice!,
      etaMinutes: estimateEtaMinutes(
        this.operatorService['calculateDistance'](lat, lon, Number(offer.operator.latitude), Number(offer.operator.longitude)),
      ),
    }));
    const ranked = rankQuotes(forRanking);

    const selected = ranked[choice - 1];
    if (!selected) {
      return this.reply(`That's not one of the options. Please reply with a valid number from the list.`);
    }

    // Atomic claim — only proceeds if the request is still DISPATCHING.
    const claimed = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequestId, status: RescueRequestStatus.DISPATCHING },
      data: { status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
    });
    if (claimed.count === 0) {
      return this.reply(`Sorry, this request has already moved on.`);
    }

    const config = await this.platformConfigService.getConfig();
    const serviceFeeAmount = Math.round((selected.quotedPrice * config.serviceFeePercent) / 100);
    const total = selected.quotedPrice + serviceFeeAmount;
    const depositAmount = Math.round((total * config.depositPercent) / 100);
    const balanceAmount = total - depositAmount;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { serviceFeeAmount, depositAmount, balanceAmount, assignedOperatorId: selected.operatorId },
    });

    const selectedOffer = quotedOffers.find((o) => o.id === selected.offerId)!;
    await this.prisma.dispatchOffer.update({
      where: { id: selectedOffer.id },
      data: { status: 'SELECTED_PENDING_PAYMENT', respondedAt: new Date() },
    });
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'QUOTED', id: { not: selectedOffer.id } },
      data: { status: 'NOT_SELECTED', respondedAt: new Date() },
    });

    // Notify the operators who weren't picked.
    await Promise.all(
      quotedOffers
        .filter((o) => o.id !== selectedOffer.id)
        .map((o) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(o.operator.phoneNumber),
            `Sorry, the customer chose another quote — thanks for bidding!`,
          ),
        ),
    );

    await this.sessionStore.update(userId, { state: WhatsAppFlowState.OPERATOR_FOUND_WAITING_PAYMENT });

    const operator = selectedOffer.operator;
    const reference = this.paystackService.generateReference('DEP');
    const email = rescueRequest.customer.email ?? `${phoneNumber.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: depositAmount,
      reference,
      metadata: {
        rescueRequestId,
        customerId: rescueRequest.customerId,
        phoneNumber,
        type: 'deposit',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to create deposit payment link:', paymentResponse);
      return this.reply(`⚠️ We couldn't generate a payment link. Our team has been alerted. Reply CANCEL to cancel.`);
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { depositReference: reference },
    });

    const depositNaira = (depositAmount / 100).toLocaleString();
    const balanceNaira = (balanceAmount / 100).toLocaleString();

    void this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `🚗 *Operator selected!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⏳ You have *5 minutes* to confirm:\n\n${paymentResponse.data.authorization_url}\n\nThe operator is standing by. Reply CANCEL to cancel (no charge).`,
    );

    const DEPOSIT_WINDOW_MS = 5 * 60 * 1000;
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return;

      await this.prisma.dispatchOffer.update({
        where: { id: selectedOffer.id },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
      });
      const freshSession = await this.sessionStore.getOrCreate(rescueRequest.customerId);
      await this.sessionStore.update(rescueRequest.customerId, {
        state: WhatsAppFlowState.REQUEST_CONFIRMED,
        offeredOperatorIds: [...(freshSession.offeredOperatorIds ?? []), operator.id],
      });
      await this.twilioService.sendWhatsAppMessage(
        phoneNumber,
        `⏰ Payment window expired. Looking for the next available operator...`,
      );
      void this.startDispatch(rescueRequestId, rescueRequest.customerId);
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `⏰ The customer did not pay within 5 minutes. You have been released. Watch for new offers!`,
      );
    }, DEPOSIT_WINDOW_MS);

    return this.xmlOk();
  }

  // ══════════════════════════════════════════════════════
  //  OFFER RESPONSE — channel-agnostic core
  //  Used by both the WhatsApp handler above and the dashboard API.
  // ══════════════════════════════════════════════════════

  /** List PENDING dispatch offers for all operators this user belongs to. */
  async listMyPendingOffers(userId: string) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    if (memberships.length === 0) return { data: [] };

    const offers = await this.prisma.dispatchOffer.findMany({
      where: {
        operatorId: { in: memberships.map((m) => m.operatorId) },
        status: 'PENDING',
        expiresAt: { gte: new Date() },
      },
      include: {
        rescueRequest: {
          select: {
            id: true, latitude: true, longitude: true, createdAt: true,
            vehicleType: true, destination: true,
            media: { select: { id: true } },
          },
        },
      },
      orderBy: { offeredAt: 'desc' },
    });

    const apiBaseUrl = process.env.API_BASE_URL;

    // Note: customer contact details are deliberately NOT exposed before acceptance.
    return {
      data: offers.map((o) => ({
        id:        o.id,
        offeredAt: o.offeredAt,
        expiresAt: o.expiresAt,
        request: {
          id:          o.rescueRequest.id,
          vehicleType: o.rescueRequest.vehicleType,
          destination: o.rescueRequest.destination,
          latitude:    o.rescueRequest.latitude,
          longitude:   o.rescueRequest.longitude,
          createdAt:   o.rescueRequest.createdAt,
          mediaLinks: apiBaseUrl
            ? o.rescueRequest.media.map((m) => `${apiBaseUrl}/api/v1/media/${m.id}`)
            : [],
        },
      })),
    };
  }

  /** Submit a price quote (or decline) for a pending offer from the dashboard. */
  async respondToOffer(userId: string, offerId: string, priceKobo?: number) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    const operatorIds = memberships.map((m) => m.operatorId);

    const offer = await this.prisma.dispatchOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer || !operatorIds.includes(offer.operatorId)) {
      throw new NotFoundException('Offer not found');
    }
    if (offer.status !== 'PENDING') {
      throw new BadRequestException('This offer is no longer available.');
    }

    const result = await this.processQuoteOrDecline(offer, priceKobo);
    return { data: result };
  }

  // ══════════════════════════════════════════════════════
  //  MARK JOB COMPLETED → trigger balance payment
  // ══════════════════════════════════════════════════════

  async markJobCompleted(rescueRequestId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) throw new Error('Rescue request not found');

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data:  { status: RescueRequestStatus.COMPLETED },
    });

    const subscription = await this.getActiveSubscription(rescueRequest.customerId);
    if (!subscription && !rescueRequest.balancePaid) {
      await this.sendBalancePaymentLink(rescueRequest);
    }
  }

  private async sendBalancePaymentLink(rescueRequest: any) {
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (!customerPhone) return;

    const balanceAmount = rescueRequest.balanceAmount;
    if (!balanceAmount) {
      console.error('No balanceAmount persisted for rescue request:', rescueRequest.id);
      Sentry.captureMessage(`sendBalancePaymentLink: missing balanceAmount for ${rescueRequest.id}`, 'error');
      return;
    }

    const reference = this.paystackService.generateReference('BAL');
    const email = rescueRequest.customer.email || `${customerPhone.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: balanceAmount,
      reference,
      metadata: {
        rescueRequestId: rescueRequest.id,
        customerId:      rescueRequest.customerId,
        phoneNumber:     customerPhone,
        type: 'balance',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to create balance payment link:', paymentResponse);
      return;
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { balanceReference: reference },
    });

    const balanceNaira = (balanceAmount / 100).toLocaleString();
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `✅ Your tow is complete!\n\nPlease pay the ₦${balanceNaira} balance:\n\n${paymentResponse.data.authorization_url}\n\nThank you for using Lagos Roadside Rescue 🚗`,
    );
  }

  // ══════════════════════════════════════════════════════
  //  ADMIN API (fully implemented)
  // ══════════════════════════════════════════════════════

  async adminList(query: any) {
    const {
      status, issueType, operatorId, depositPaid, balancePaid,
      from, to, search, page = 1, limit = 20,
    } = query;

    const where: any = {};
    if (status)     where.status    = status;
    if (issueType)  where.issueType = issueType;
    if (operatorId) where.assignedOperatorId = operatorId;
    if (depositPaid !== undefined) where.depositPaid = depositPaid === 'true' || depositPaid === true;
    if (balancePaid !== undefined) where.balancePaid = balancePaid === 'true' || balancePaid === true;
    if (from && to) where.createdAt = { gte: new Date(from), lte: new Date(to) };
    if (search) {
      where.OR = [
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { name:        { contains: search, mode: 'insensitive' } } },
      ];
    }
    return this.buildListResponse(where, Number(page), Number(limit));
  }

  async adminDetail(id: string) {
    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
        dispatchOffers:  {
          include: { operator: { select: { id: true, businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');
    return { data: { ...this.mapToDetailDto(raw), dispatchOffers: raw.dispatchOffers } };
  }

  async assignOperator(id: string, dto: { operatorId: string }) {
    if (!dto.operatorId) throw new BadRequestException('operatorId is required');

    const operator = await this.prisma.operator.findUnique({ where: { id: dto.operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');

    const request = await this.prisma.rescueRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Rescue request not found');
    if (([RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] as RescueRequestStatus[]).includes(request.status)) {
      throw new BadRequestException(`Cannot assign an operator to a ${request.status} request`);
    }

    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data:  { assignedOperatorId: dto.operatorId, status: RescueRequestStatus.OPERATOR_ASSIGNED },
      include: { customer: true, assignedOperator: true },
    });

    if (updated.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        updated.customer.phoneNumber,
        `🚗 An operator has been assigned to your request.\n\nBusiness: ${updated.assignedOperator?.businessName}\nPhone: ${updated.assignedOperator?.phoneNumber}`,
      );
    }
    return { data: this.mapToDetailDto(updated) };
  }

  async updateStatus(id: string, dto: { status: string }) {
    const status = dto.status as RescueRequestStatus;
    if (!Object.values(RescueRequestStatus).includes(status)) {
      throw new BadRequestException(`Invalid status: ${dto.status}`);
    }
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data:  { status },
      include: { customer: true },
    });

    if (status === RescueRequestStatus.COMPLETED) {
      await this.markJobCompleted(id);
    }
    return { data: this.mapToDetailDto(updated) };
  }

  async cancel(id: string, dto: { reason?: string }) {
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data:  { status: RescueRequestStatus.CANCELLED },
      include: { customer: true },
    });

    if (updated.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        updated.customer.phoneNumber,
        `❌ Your rescue request has been cancelled${dto.reason ? `: ${dto.reason}` : '.'}\n\nSend SOS or HELP if you need assistance again.`,
      );
    }
    return { data: this.mapToDetailDto(updated) };
  }

  // ══════════════════════════════════════════════════════
  //  OPERATOR API
  // ══════════════════════════════════════════════════════

  async operatorList(userId: string, query: any) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    if (memberships.length === 0) return { data: [], meta: { page: 1, limit: 20, total: 0 } };

    const operatorIds = memberships.map((m) => m.operatorId);
    const where: any = { assignedOperatorId: { in: operatorIds } };
    const { status, page = 1, limit = 20 } = query;
    if (status) where.status = status;

    return this.buildListResponse(where, Number(page), Number(limit));
  }

  async operatorDetail(userId: string, id: string) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    const operatorIds = memberships.map((m) => m.operatorId);

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
      },
    });

    if (!raw || !operatorIds.includes(raw.assignedOperatorId!)) {
      throw new UnauthorizedException('Rescue request not found or access denied');
    }
    return { data: this.mapToDetailDto(raw) };
  }

  // ══════════════════════════════════════════════════════
  //  UNIFIED LIST / DETAIL (role-aware)
  // ══════════════════════════════════════════════════════

  async listForUser(user: any, query: any) {
    const { role } = user;
    const { status, issueType, operatorId, depositPaid, balancePaid, from, to, search, page = 1, limit = 20 } = query;

    const whereClause: any = {};
    if (status)     whereClause.status    = status;
    if (issueType)  whereClause.issueType = issueType;
    if (depositPaid !== undefined) whereClause.depositPaid = depositPaid === 'true' || depositPaid === true;
    if (balancePaid !== undefined) whereClause.balancePaid = balancePaid === 'true' || balancePaid === true;
    if (from && to) whereClause.createdAt = { gte: new Date(from), lte: new Date(to) };
    else if (from)  whereClause.createdAt = { gte: new Date(from) };
    else if (to)    whereClause.createdAt = { lte: new Date(to) };
    if (search) {
      whereClause.OR = [
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { name:        { contains: search, mode: 'insensitive' } } },
        { assignedOperator: { businessName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      if (operatorId) whereClause.assignedOperatorId = operatorId;
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId: user.userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (operatorIds.length === 0) return { data: [], meta: { page: 1, limit, total: 0 } };
      whereClause.assignedOperatorId = { in: operatorIds };
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    // CUSTOMER — only see their own requests
    if (role === 'CUSTOMER') {
      whereClause.customerId = user.userId;
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    throw new UnauthorizedException('Access denied');
  }

  async detailForUser(user: any, id: string): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') return { data: this.mapToDetailDto(raw) };

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (!operatorIds.includes(raw.assignedOperatorId!)) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    throw new UnauthorizedException('Customers do not have access to rescue request details');
  }

  // ══════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ══════════════════════════════════════════════════════

  private async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where:  { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }

  private async getActiveSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        currentPeriodEnd: { gte: new Date() },
      },
    });
  }

  private async alertAdminNoOperator(
    rescueRequestId: string,
    lat: number,
    lon: number,
    round: number,
  ) {
    console.warn(
      `🚨 ADMIN ALERT: No operator after ${round} rounds for request ${rescueRequestId} @ ${lat},${lon}`,
    );
    // Hook to admin notification service when available
  }

  private async buildListResponse(where: any, page: number, limit: number): Promise<RescueRequestListResponseDto> {
    const skip = (page - 1) * limit;
    const [rawData, total] = await Promise.all([
      this.prisma.rescueRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer:        { select: { id: true, phoneNumber: true } },
          assignedOperator: { select: { id: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.rescueRequest.count({ where }),
    ]);

    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id:        item.id,
      status:    item.status,
      issueType: item.issueType ?? undefined,
      latitude:  item.latitude  ? Number(item.latitude)  : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: item.depositPaid,
      balancePaid: item.balancePaid,
      customer: { id: item.customer.id, phoneNumber: item.customer.phoneNumber! },
      assignedOperator: item.assignedOperator
        ? { id: item.assignedOperator.id, businessName: item.assignedOperator.businessName }
        : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    const meta: PaginationMetaDto = { page, limit, total };
    return { data, meta };
  }

  private mapToDetailDto(raw: any): RescueRequestDetailDto {
    return {
      id:               raw.id,
      status:           raw.status,
      issueType:        raw.issueType  ?? undefined,
      latitude:         raw.latitude   ? Number(raw.latitude)  : undefined,
      longitude:        raw.longitude  ? Number(raw.longitude) : undefined,
      depositPaid:      raw.depositPaid,
      depositAmount:    raw.depositAmount,
      depositReference: raw.depositReference,
      balancePaid:      raw.balancePaid,
      balanceAmount:    raw.balanceAmount,
      balanceReference: raw.balanceReference,
      customer: {
        id:          raw.customer.id,
        phoneNumber: raw.customer.phoneNumber,
        email:       raw.customer.email,
        name:        raw.customer.name,
      },
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  private isSosMessage(message: string): boolean {
    return ['help', 'sos', 'stuck', 'rescue', 'emergency'].some((w) => message.includes(w));
  }

  private mapIssueType(message: string): IssueType | undefined {
    const map: Record<string, IssueType> = {
      '1': 'BREAKDOWN', '2': 'ACCIDENT', '3': 'FLAT_TYRE', '4': 'FUEL',
      'breakdown': 'BREAKDOWN', 'accident': 'ACCIDENT',
      'flat': 'FLAT_TYRE', 'tyre': 'FLAT_TYRE', 'fuel': 'FUEL',
    };
    return map[message];
  }

  private formatIssueType(issueType: IssueType): string {
    return issueType.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private formatStatus(status: RescueRequestStatus): string {
    return status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Builds the "Photos/Video/Audio" section appended to the operator offer
   * message. Best-effort: if API_BASE_URL isn't configured, the section is
   * simply omitted — this must never block the dispatch offer itself.
   */
  private buildMediaLinksSection(mediaItems: Array<{ id: string }>): string {
    if (mediaItems.length === 0) return '';

    const apiBaseUrl = process.env.API_BASE_URL;
    if (!apiBaseUrl) return '';

    const links = mediaItems
      .map((item) => `${apiBaseUrl}/api/v1/media/${item.id}`)
      .join('\n');

    return `\n\n📎 Photos/Video/Audio:\n${links}`;
  }

  private reply(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>${message}</Message>\n</Response>`;
  }

  private xmlOk(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  }
}
