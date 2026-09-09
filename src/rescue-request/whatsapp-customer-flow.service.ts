import { BadRequestException, Injectable, forwardRef, Inject } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import * as crypto from 'crypto';
import { toWhatsAppAddress } from '../common/phone.util';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { IssueType, WhatsAppFlowState } from './state/whatsapp-session.types';
import { PrismaService } from '../prisma/prisma.service';
import { RescueRequestStatus, UserRole, VehicleType, MediaType, RatingDirection } from '@prisma/client';
import { mapVehicleTypeReply, formatVehicleType } from './domain/vehicle-truck-mapping';
import { estimateEtaMinutes, rankQuotes } from './domain/quote-ranking';
import { formatIssueType, formatStatus, formatJobRef } from './domain/rescue-request-formatting';
import { classifyMediaType, getExtensionFromContentType } from './domain/media-classification';
import { S3Service } from '../integrations/s3/s3.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { RatingService } from '../rating/rating.service';
import { DispatchService } from './dispatch.service';
import { DisputeService } from './dispute.service';
// markJobCompleted (CONFIRM path) closes a real two-way dependency with this
// service — PaymentEventsService needs scheduleRatingTimeout in return.
import { PaymentEventsService } from './payment-events.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';

const DEPOSIT_AMOUNT_KOBO = 500000;   // ₦5,000
const MAX_MEDIA_ITEMS = 5;

@Injectable()
export class WhatsAppCustomerFlowService {
  private readonly RATING_TIMEOUT_MS = 10 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly s3Service: S3Service,
    private readonly geocodingService: GeocodingService,
    private readonly ratingService: RatingService,
    private readonly paystackService: PaystackService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly operatorService: OperatorService,
    private readonly dispatchService: DispatchService,
    // DisputeService now depends on PaymentEventsService (which already
    // forwardRef's back to this class), so this edge closes a 3-hop cycle
    // and needs forwardRef too, same as the PaymentEventsService edge below.
    @Inject(forwardRef(() => DisputeService))
    private readonly disputeService: DisputeService,
    @Inject(forwardRef(() => PaymentEventsService))
    private readonly paymentEventsService: PaymentEventsService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly sharedService: RescueRequestSharedService,
  ) {}

  /**
   * If a rating prompt goes unanswered, silently clear that party's session
   * back to IDLE after RATING_TIMEOUT_MS — ratings don't block anything, so
   * this is quiet cleanup, not a hard deadline. Checks the session is still
   * WAITING_FOR_RATING for the SAME rescueRequestId before clearing, so it
   * can't clobber a state the party has since moved past (already rated, or
   * started a fresh SOS).
   */
  scheduleRatingTimeout(userId: string, rescueRequestId: string) {
    setTimeout(async () => {
      const fresh = await this.sessionStore.getOrCreate(userId);
      if (fresh.state === WhatsAppFlowState.WAITING_FOR_RATING && fresh.rescueRequestId === rescueRequestId) {
        await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, this.RATING_TIMEOUT_MS);
  }

  /**
   * Customer-side WhatsApp state machine. Called by WhatsAppInboundService
   * (Task 8) after it has already resolved (or created) the User and routed
   * operator messages elsewhere — this only ever sees customer traffic.
   */
  async handleCustomerMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    rawMessage: string,
    latitude: number | undefined,
    longitude: number | undefined,
    sharedAddress: string | undefined,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    body: Record<string, any>,
  ) {
    // ── Waiting for dispute statement (customer's side of the story) ──────
    // MUST come before every other branch below, same reasoning as the
    // operator-side equivalent: whatever the customer sends next while in
    // this state is their statement, not a command.
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_REASON) {
      if (session.rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: session.rescueRequestId },
          data: { customerDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM });
      return this.reply(`Thanks — we've recorded that. Our team will be in touch.`);
    }

    // ── CONFIRM / DISPUTE job completion (customer side) ──────────────────
    if (session.state === WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM) {
      if (message === 'confirm') {
        if (session.rescueRequestId) {
          try {
            await this.paymentEventsService.markJobCompleted(session.rescueRequestId);
            await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
          } catch (err) {
            // Typically: this request was disputed. Fetch current dispute
            // state to phrase the reply correctly — "still under review" if
            // unresolved, or "check the payment link we already sent" if
            // staff have already resolved it (resolveDispute sends its own
            // settlement link; this CONFIRM must not send a second one).
            if (err instanceof BadRequestException) {
              const current = await this.prisma.rescueRequest.findUnique({
                where: { id: session.rescueRequestId! },
                select: { disputeResolvedAt: true },
              });
              return this.reply(
                current?.disputeResolvedAt
                  ? `Your dispute has been resolved — please use the payment link we already sent to complete payment.`
                  : `This request is still under dispute review — our team will follow up before you can confirm completion.`,
              );
            }
            throw err;
          }
        }
        return this.xmlOk();
      }
      if (message === 'dispute') {
        if (session.rescueRequestId) {
          await this.disputeService.raiseDispute(session.rescueRequestId, phoneNumber, userId);
        }
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
            `⚠️ You already have an active rescue request (${formatStatus(openRequest.status)}).\n\nWe're on it! Reply CANCEL to cancel the current request.`,
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
            `❌ ${formatJobRef(existing.id)} is no longer available — the customer cancelled before paying. Watch out for new offers!`,
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
        `🚗 ${formatVehicleType(vehicleType)} noted!\n\nWhere would you like the car towed to? Type an address, or share a location pin.`,
      );
    }

    // ── Step 3: Waiting for destination ────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_DESTINATION) {
      let destination: string | undefined;

      if (latitude !== undefined && longitude !== undefined) {
        // A "search for a place" share includes WhatsApp's own formatted
        // address — prefer it. A bare "current location" pin has none, so
        // fall back to reverse-geocoding, and to raw coordinates only if
        // that also comes up empty, rather than losing the pin entirely.
        if (sharedAddress) {
          destination = sharedAddress;
        } else {
          const geocoded = await this.geocodingService.reverseGeocode(latitude, longitude);
          destination = geocoded ?? `${latitude}, ${longitude}`;
        }
      } else if (rawMessage) {
        destination = rawMessage;
      }

      if (!destination) {
        return this.reply(`Please type where you'd like the car towed to, or share a location pin.`);
      }

      const customer = await this.sharedService.findOrCreateCustomer(phoneNumber);
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
        `🚗 Please pay using the link we sent you to confirm your operator.\n\nYou have 5 minutes before the request is cancelled.\n\nReply CANCEL to cancel (you will not be charged).`,
      );
    }

    // ── Step 4: Request active — searching for operator ───────────────────
    if (session.state === WhatsAppFlowState.REQUEST_CONFIRMED) {
      return this.reply(
        `🔍 We've received your request and are searching for the nearest operator.\n\nYou will be notified once one is confirmed. Reply CANCEL to cancel (no charge).`,
      );
    }

    // ── Step 5: Waiting for post-job rating (motorist rates operator) ─────
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.handleRatingReply(
        userId, rawMessage, session.rescueRequestId, RatingDirection.MOTORIST_TO_OPERATOR,
      );
    }

    return this.reply(
      `👋 Welcome to Local Roadside Rescue.\n\nSend HELP or SOS if you need roadside assistance.`,
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

      logger.info('media: attachment saved', { rescueRequestId, mediaType, contentType });
      return true;
    } catch (error) {
      console.error('Failed to capture media attachment:', error);
      Sentry.captureException(error);
      return false;
    }
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

    void this.dispatchService.startDispatch(rescueRequestId, customer.id);
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
      ? `💰 *Total cost: ₦50,000*\n   • ₦5,000 deposit now to confirm\n   • ₦45,000 balance on job completion — car released after payment\n`
      : `💰 *One-time fee: ₦50,000* (paid in full now)\n`;

    return this.reply(
      `Issue: ${formatIssueType(issueType)}${note}\n\n${costBreakdown}\n⚠️ *ACTION NEEDED* — tap the link below to pay ${isStandardDeposit ? '₦5,000 deposit' : '₦50,000'} and confirm your rescue:\n\n👉 ${paymentResponse.data.authorization_url}\n\n⏱ Pay within 30 minutes or the request is cancelled.`,
    );
  }

  async handleRatingReply(
    reviewerUserId: string,
    rawMessage: string,
    rescueRequestId: string | undefined,
    direction: RatingDirection,
  ) {
    const score = Number(rawMessage.trim());
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return this.reply(`Please reply with a number from 1 to 5.`);
    }

    if (!rescueRequestId) {
      await this.sessionStore.update(reviewerUserId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Thanks for your feedback!`);
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { customerId: true, assignedOperatorId: true },
    });

    if (!rescueRequest?.assignedOperatorId) {
      await this.sessionStore.update(reviewerUserId, {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
      return this.reply(`Thanks for your feedback!`);
    }

    // Create the rating BEFORE clearing the session — if this throws (DB
    // error), the session stays WAITING_FOR_RATING so the reviewer's next
    // message re-enters this handler and can retry, instead of silently
    // losing the rating while the session has already moved to IDLE.
    const rating = await this.ratingService.create({
      rescueRequestId,
      direction,
      operatorId: rescueRequest.assignedOperatorId,
      customerId: rescueRequest.customerId,
      score,
    });

    await this.sessionStore.update(reviewerUserId, {
      state: WhatsAppFlowState.IDLE,
      rescueRequestId: undefined,
    });

    // Low rating (either direction) — alert staff so someone actually looks
    // at what went wrong, rather than the score just sitting in the DB
    // unnoticed. Best-effort: a failed alert never blocks the reviewer's
    // own reply.
    if (score <= 2) {
      try {
        const config = await this.platformConfigService.getConfig();
        if (config.disputeAlertPhoneNumber) {
          const who = direction === RatingDirection.MOTORIST_TO_OPERATOR
            ? 'Customer rated the operator'
            : 'Operator rated the customer';
          await this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(config.disputeAlertPhoneNumber),
            `⚠️ Low rating (${score}/5) on ${formatJobRef(rescueRequestId)} — ${who} low. Please review.`,
          );
        }
      } catch (error) {
        console.error('Failed to send low-rating staff alert:', error);
      }
    }

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    return this.reply(
      `Thanks for rating us ${score}/5! 🙏\n\nWant to add more detail? Tell us more here: ${frontendUrl}/feedback/${rating.id}`,
    );
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
      `🚗 *Operator selected!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⚠️ *ACTION NEEDED* — tap the link below to pay and confirm. You have *5 minutes*:\n\n👉 ${paymentResponse.data.authorization_url}\n\nYour operator is confirmed once you pay. Reply CANCEL to cancel (no charge).`,
    );

    this.sharedService.scheduleDepositWindow({
      rescueRequestId,
      customerId: userId,
      customerPhone: phoneNumber,
      operatorPhone: toWhatsAppAddress(operator.phoneNumber),
      paymentUrl: paymentResponse.data.authorization_url,
    });

    return this.xmlOk();
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

  private reply(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>${message}</Message>\n</Response>`;
  }

  private xmlOk(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  }
}
