import { Injectable } from '@nestjs/common';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { STALLED_CONFIRMATION_MS } from './confirmation.constants';
import { TwilioService } from '../integrations/twilio/twilio.service';
import {
  RescueRequestStatus,
  RatingDirection,
  VehicleType,
  MediaContext,
  MediaType,
  UserRole,
} from '@prisma/client';
import { formatJobRef } from './domain/rescue-request-formatting';
import { formatVehicleType } from './domain/vehicle-truck-mapping';
import { classifyMediaType } from './domain/media-classification';
import { DispatchService } from './dispatch.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { toWhatsAppAddress, toWhatsAppDestination } from '../common/phone.util';
import { PlatformConfigService } from '../platform-config/platform-config.service';

const MAX_MEDIA_ITEMS = 5;

@Injectable()
export class WhatsAppOperatorFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly dispatchService: DispatchService,
    private readonly paymentEventsService: PaymentEventsService,
    private readonly customerFlowService: WhatsAppCustomerFlowService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  //  Operator message router
  // ──────────────────────────────────────────────────────────────────────────
  async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    rawMessage: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
    body: Record<string, any>,
  ) {
    // Strip thousands separators so "100,000" parses the same as "100000" —
    // no valid operator command otherwise contains a comma.
    message = message.replace(/,/g, '');

    // ── Masked chat relay ───────────────────────────────────────────────────
    // Checked before everything else — see the matching customer-side
    // comment for why (orthogonal to `state`, explicit-exit only).
    if (session.relayTarget) {
      if (message === 'end chat') {
        await this.endChatRelay(userId, phoneNumber, session.rescueRequestId);
        return this.xmlOk();
      }
      if (session.rescueRequestId) {
        const rescueRequest = await this.prisma.rescueRequest.findUnique({
          where: { id: session.rescueRequestId },
          include: { customer: true },
        });
        if (rescueRequest?.customer) {
          await this.twilioService.sendWhatsAppMessage(
            toWhatsAppDestination(rescueRequest.customer),
            `Driver: ${rawMessage}`,
          );
        }
      }
      return this.xmlOk();
    }

    // ── Waiting for dispute statement (operator's side of the story) ──────
    // MUST come before every other branch below — none of them apply once
    // we've asked the operator for a free-text statement, and a numeric or
    // keyword-shaped reply here must not be mistaken for a price quote or
    // command.
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE) {
      const rescueRequestId = session.rescueRequestId;
      const numMedia = Number(body.NumMedia ?? 0);

      if (rescueRequestId && numMedia > 0) {
        let existingCount = await this.prisma.requestMedia.count({
          where: {
            rescueRequestId,
            context: MediaContext.DISPUTE,
            uploadedByRole: UserRole.OPERATOR,
          },
        });
        for (let i = 0; i < numMedia; i++) {
          if (existingCount >= MAX_MEDIA_ITEMS) break;
          const mediaUrl = body[`MediaUrl${i}`] as string | undefined;
          const contentType = body[`MediaContentType${i}`] as
            | string
            | undefined;
          if (!mediaUrl || !contentType) continue;
          const saved = await this.customerFlowService.captureMediaAttachment(
            rescueRequestId,
            mediaUrl,
            contentType,
            MediaContext.DISPUTE,
            UserRole.OPERATOR,
          );
          if (saved) existingCount++;
        }
      }

      if (!rawMessage) {
        return this.reply(
          `📸 Got it — send more evidence, or reply with your explanation to finish.`,
        );
      }

      if (rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { operatorDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
      });
      return this.reply(
        `Thanks — we've recorded that. Our team will be in touch.`,
      );
    }

    // ── Awaiting completion evidence ────────────────────────────────────
    // MUST come before the quote-parsing check below — "1"/"2" here are
    // the add-more/continue menu, not a price quote, and would otherwise
    // be silently swallowed as a bogus bare-digit quote attempt.
    if (
      session.state === WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA
    ) {
      const rescueRequestId = session.rescueRequestId;
      if (!rescueRequestId) {
        await this.sessionStore.update(userId, {
          state: WhatsAppFlowState.OPERATOR_ON_JOB,
        });
        return this.reply(
          `Sorry, we lost track of this job. Please send ARRIVED/DONE again.`,
        );
      }

      if (message === '1') {
        return this.reply(`Go ahead — send your photo(s) or video(s).`);
      }

      if (message === '2') {
        const visualCount = await this.prisma.requestMedia.count({
          where: {
            rescueRequestId,
            context: MediaContext.COMPLETION,
            uploadedByRole: UserRole.OPERATOR,
            mediaType: { in: [MediaType.IMAGE, MediaType.VIDEO] },
          },
        });
        if (visualCount === 0) {
          return this.reply(
            `Please send at least one photo or video before continuing.`,
          );
        }
        return this.handleOperatorJobDone(
          phoneNumber,
          userId,
          rescueRequestId,
          operator,
        );
      }

      const numMedia = Number(body.NumMedia ?? 0);
      if (numMedia === 0) {
        return this.reply(
          `Please send at least one photo or video.\n\n1️⃣ Add more\n2️⃣ Continue`,
        );
      }

      const existingCount = await this.prisma.requestMedia.count({
        where: {
          rescueRequestId,
          context: MediaContext.COMPLETION,
          uploadedByRole: UserRole.OPERATOR,
        },
      });
      let savedCount = existingCount;
      let failedCount = 0;
      let audioSkipped = 0;
      let capReached = false;

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = body[`MediaUrl${i}`] as string | undefined;
        const contentType = body[`MediaContentType${i}`] as string | undefined;
        if (!mediaUrl || !contentType) continue;

        // Audio is never saved for completion evidence — a voice note
        // would otherwise consume a cap slot without ever satisfying the
        // visual-evidence gate above, permanently blocking DONE. Checked
        // before the cap, not after, so it can never take a slot a
        // genuine photo/video needs.
        if (classifyMediaType(contentType) === MediaType.AUDIO) {
          audioSkipped++;
          continue;
        }

        if (savedCount >= MAX_MEDIA_ITEMS) {
          capReached = true;
          break;
        }

        const saved = await this.customerFlowService.captureMediaAttachment(
          rescueRequestId,
          mediaUrl,
          contentType,
          MediaContext.COMPLETION,
          UserRole.OPERATOR,
        );
        if (saved) {
          savedCount++;
        } else {
          failedCount++;
        }
      }

      const capNote = capReached
        ? `\n\n⚠️ You've reached the ${MAX_MEDIA_ITEMS}-item limit — further attachments won't be saved.`
        : '';
      const failNote =
        failedCount > 0
          ? `\n\n⚠️ ${failedCount} item(s) failed to upload — please resend if important.`
          : '';
      const audioNote =
        audioSkipped > 0
          ? `\n\n🎤 Voice notes aren't used as completion evidence — please send a photo or video instead.`
          : '';

      return this.reply(
        `📸 Received (${savedCount}/${MAX_MEDIA_ITEMS} items saved).${capNote}${failNote}${audioNote}\n\n1️⃣ Add more\n2️⃣ Continue`,
      );
    }

    // ── Waiting for post-job rating (operator rates motorist) ─────────────
    // MUST come before the quote-parsing check below, which treats any bare
    // digit as a dispatch-offer price quote — without this ordering, a
    // rating reply would be silently swallowed as a bogus quote attempt.
    //
    // BUT only when there's no open dispatch offer right now: operators can
    // be offered a new job while still owing a rating on a previous one
    // (operator.service.ts findAndRankCandidates deliberately has no busy
    // filter), and a "NO" declining that new offer must not be swallowed as
    // an invalid rating reply. An open offer is the newer, more urgent
    // prompt — it wins. Session state stays WAITING_FOR_RATING either way,
    // so the operator can still rate once they're free.
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      const openOffers = await this.findOpenOffers(operator.id);
      if (openOffers.length === 0) {
        return this.customerFlowService.handleRatingReply(
          userId,
          message,
          session.rescueRequestId,
          RatingDirection.OPERATOR_TO_MOTORIST,
        );
      }
    }

    // ── Dispatch quote / decline ─────────────────────────────────────────
    // "JOBREF PRICE" / "JOBREF NO" disambiguates which job this reply is for
    // when an operator has more than one offer open at once — see
    // handleOperatorQuoteOrDecline for what happens when it's left out.
    // The leading # is optional throughout: the offer message and the job
    // list both render the ref as "Job #G8YJRD", so operators naturally
    // copy the # along with it. Rejecting that is punishing them for
    // reading the screen.
    const refAndDecline = message.match(/^#?([a-z0-9]{6})\s+(no|decline)$/i);
    if (refAndDecline) {
      return this.handleOperatorQuoteOrDecline(
        phoneNumber,
        userId,
        undefined,
        refAndDecline[1].toUpperCase(),
      );
    }
    const refAndPrice = message.match(/^#?([a-z0-9]{6})\s+(\d+)$/i);
    if (refAndPrice) {
      return this.handleOperatorQuoteOrDecline(
        phoneNumber,
        userId,
        Number(refAndPrice[2]) * 100,
        refAndPrice[1].toUpperCase(),
      );
    }
    // A ref on its own — the operator answered "which job?" but left out the
    // price. Handled explicitly because silence is the worst possible reply:
    // it looks identical to the system being down. Must come after the
    // keyword branches below would have matched... except those need session
    // state, so instead the ref is only accepted here when it actually
    // matches one of this operator's open offers — see resolveBareRef.
    // That keeps 6-letter commands like "onsite" and "cancel" from being
    // mistaken for job references.
    const bareRef = message.match(/^#?([a-z0-9]{6})$/i);
    if (bareRef) {
      const handled = await this.handleBareJobRef(
        phoneNumber,
        bareRef[1].toUpperCase(),
      );
      if (handled) return handled;
    }
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(
        phoneNumber,
        userId,
        Number(message) * 100,
      );
    }

    // ── ARRIVED at customer location ───────────────────────────────────────
    if (
      message === 'arrived' ||
      message === 'on site' ||
      message === 'onsite'
    ) {
      if (
        session.state !== WhatsAppFlowState.OPERATOR_ON_JOB ||
        !session.rescueRequestId
      ) {
        logger.info('whatsapp: ARRIVED rejected — wrong session state', {
          operatorId: operator.id,
          sessionState: session.state,
          rescueRequestId: session.rescueRequestId,
        });
        return this.reply(
          `You don't have an active job. Wait for a dispatch offer.`,
        );
      }
      logger.info('whatsapp: ARRIVED accepted', {
        operatorId: operator.id,
        rescueRequestId: session.rescueRequestId,
      });
      return this.handleOperatorArrived(
        phoneNumber,
        userId,
        session.rescueRequestId,
        operator,
      );
    }

    // ── Job DONE — prompt customer to confirm ──────────────────────────────
    if (
      message === 'done' ||
      message === 'complete' ||
      message === 'finished'
    ) {
      if (
        session.state !== WhatsAppFlowState.OPERATOR_AT_LOCATION ||
        !session.rescueRequestId
      ) {
        logger.info('whatsapp: DONE rejected — wrong session state', {
          operatorId: operator.id,
          sessionState: session.state,
          rescueRequestId: session.rescueRequestId,
        });
        return this.reply(
          `Please send ARRIVED first when you reach the customer location.`,
        );
      }
      logger.info('whatsapp: DONE accepted — awaiting completion evidence', {
        operatorId: operator.id,
        rescueRequestId: session.rescueRequestId,
      });
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      });
      return this.reply(
        `📸 Please send at least one photo or video showing the completed job.`,
      );
    }

    // ── Contextual help ───────────────────────────────────────────────────
    if (session.state === WhatsAppFlowState.OPERATOR_ON_JOB) {
      logger.info(
        'whatsapp: unrecognized message while ON_JOB — sent ARRIVED reminder',
        {
          operatorId: operator.id,
          message,
          rescueRequestId: session.rescueRequestId,
        },
      );
      // TwiML's <Message> verb has no contentSid attribute — a button can
      // only go out via the async REST call, so the template branch sends
      // that and acks the webhook empty instead of replying with text.
      // Full definition: TWILIO_CONTENT_TEMPLATES.arrived_reminder in
      // src/integrations/twilio/twilio-content-templates.ts.
      const arrivedReminderSid =
        process.env.TWILIO_ARRIVED_REMINDER_TEMPLATE_SID;
      const arrivedReminderText = `📍 ${formatJobRef(session.rescueRequestId!)} — Send *ARRIVED* when you reach the customer location so we can notify them.`;
      if (arrivedReminderSid) {
        return this.replyWithTemplateOrText(
          await this.resolveOperatorReminderDestination(userId, operator),
          arrivedReminderSid,
          { '1': formatJobRef(session.rescueRequestId!) },
          arrivedReminderText,
        );
      }
      return this.reply(arrivedReminderText);
    }
    if (session.state === WhatsAppFlowState.OPERATOR_AT_LOCATION) {
      // Full definition: TWILIO_CONTENT_TEMPLATES.done_reminder in
      // src/integrations/twilio/twilio-content-templates.ts.
      const doneReminderSid = process.env.TWILIO_DONE_REMINDER_TEMPLATE_SID;
      const doneReminderText = `✅ ${formatJobRef(session.rescueRequestId!)} — Send *DONE* when the job is complete. The customer will confirm and you'll both be notified.`;
      if (doneReminderSid) {
        return this.replyWithTemplateOrText(
          await this.resolveOperatorReminderDestination(userId, operator),
          doneReminderSid,
          { '1': formatJobRef(session.rescueRequestId!) },
          doneReminderText,
        );
      }
      return this.reply(doneReminderText);
    }

    // Nothing matched — the operator's message went entirely unhandled and
    // got silent empty TwiML back. This used to be invisible; log it so an
    // operator saying "nothing happened" is traceable to what they actually sent.
    logger.info('whatsapp: operator message unhandled — no branch matched', {
      operatorId: operator.id,
      message,
      sessionState: session.state,
      rescueRequestId: session.rescueRequestId,
    });
    return this.xmlOk();
  }

  /**
   * Operator replied to a dispatch offer with either a price (quote) or NO
   * (decline) over WhatsApp. `quotedPriceKobo` is undefined for a decline.
   *
   * `jobRef` is the 6-char tag from formatJobRef, present when the operator
   * replied "JOBREF PRICE" instead of a bare price. With only one offer
   * pending, a bare reply is unambiguous and works as before. With more than
   * one pending, guessing which job a bare reply is for is exactly the bug
   * this disambiguates — the previous behavior (most-recently-offered wins)
   * could silently apply a quote to the wrong job.
   */
  private async handleOperatorQuoteOrDecline(
    operatorPhone: string,
    operatorUserId: string,
    quotedPriceKobo: number | undefined,
    jobRef?: string,
  ) {
    const operator = await this.prisma.operator.findUnique({
      where: { phoneNumber: operatorPhone },
    });
    if (!operator) return this.xmlOk();

    const pendingOffers = await this.findOpenOffers(operator.id);
    if (pendingOffers.length === 0) return this.xmlOk();

    let offer = pendingOffers[0];
    if (jobRef) {
      const matched = pendingOffers.find((o) =>
        formatJobRef(o.rescueRequestId).endsWith(jobRef),
      );
      if (!matched) {
        return this.reply(
          `That job reference doesn't match any of your open offers. Reply "NO" or just your price if you only have one job open.`,
        );
      }
      offer = matched;
    } else if (pendingOffers.length > 1) {
      return this.reply(
        `You have ${pendingOffers.length} jobs open at once — reply with the job reference and your price so we know which one, e.g. "${this.bareRef(pendingOffers[0].rescueRequestId)} 25000":\n\n${this.describeOffers(pendingOffers)}`,
      );
    }

    const result = await this.dispatchService.processQuoteOrDecline(
      offer,
      quotedPriceKobo,
    );
    return this.reply(result.message);
  }

  /**
   * This operator's genuinely live offers, newest first.
   *
   * expiresAt is filtered here, not just relied on via status: an offer is
   * only flipped to TIMED_OUT by DispatchService.resolveBatch or the
   * sweeper, so between a restart and the next sweep there can be PENDING
   * rows that are long dead. Without this filter they count toward "how
   * many jobs are open" and the operator is asked to disambiguate between
   * jobs that ended days ago. The dashboard equivalent
   * (DispatchService.listMyPendingOffers) already filters this way.
   */
  private async findOpenOffers(operatorId: string) {
    return this.prisma.dispatchOffer.findMany({
      where: { operatorId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { offeredAt: 'desc' },
      include: {
        rescueRequest: { select: { vehicleType: true, destination: true } },
      },
    });
  }

  /** The 6-char tag alone, matching how operators are asked to reply. */
  private bareRef(rescueRequestId: string): string {
    return formatJobRef(rescueRequestId).replace('Job #', '');
  }

  /**
   * Renders open offers as a list an operator can actually recognise.
   *
   * A bare job reference is meaningless to them — it's our identifier, not
   * theirs. What distinguishes one open job from another in their head is
   * the vehicle and where it's going, so each line carries those. Status is
   * deliberately absent: every offer in this list is PENDING by definition,
   * so printing it would add a column that never varies.
   */
  private describeOffers(
    offers: {
      rescueRequestId: string;
      rescueRequest: { vehicleType: string | null; destination: string | null };
    }[],
  ): string {
    return offers.map((o) => `• ${this.describeOffer(o)}`).join('\n');
  }

  private describeOffer(offer: {
    rescueRequestId: string;
    rescueRequest: { vehicleType: string | null; destination: string | null };
  }): string {
    const vehicle = offer.rescueRequest.vehicleType
      ? formatVehicleType(offer.rescueRequest.vehicleType as VehicleType)
      : 'Vehicle not specified';
    const destination = offer.rescueRequest.destination;
    // Only append the destination when there is one — "Sedan → " reads as a
    // rendering bug rather than as missing data.
    return destination
      ? `*${this.bareRef(offer.rescueRequestId)}* — ${vehicle} → ${destination}`
      : `*${this.bareRef(offer.rescueRequestId)}* — ${vehicle}`;
  }

  /**
   * The operator replied with a job reference and nothing else — they
   * answered "which job?" but left out the price.
   *
   * Returns null when the text doesn't match one of their open offers, so
   * the caller falls through to the ordinary command routing. That matters
   * because real commands are six characters too ("onsite", "cancel") and
   * must not be swallowed as job references.
   */
  private async handleBareJobRef(
    operatorPhone: string,
    jobRef: string,
  ): Promise<string | null> {
    const operator = await this.prisma.operator.findUnique({
      where: { phoneNumber: operatorPhone },
    });
    if (!operator) return null;

    const openOffers = await this.findOpenOffers(operator.id);
    const matched = openOffers.find((o) =>
      formatJobRef(o.rescueRequestId).endsWith(jobRef),
    );
    if (!matched) return null;

    return this.reply(
      `Got it — ${this.describeOffer(matched)}.\n\nNow send the reference *and* your price together, e.g. "${this.bareRef(matched.rescueRequestId)} 25000".\nTo turn this job down, reply "${this.bareRef(matched.rescueRequestId)} NO".`,
    );
  }

  /**
   * The customer-facing NOTIFICATION half of ARRIVED — deliberately does
   * NOT write the ARRIVED status itself. Shared between the WhatsApp
   * handler (which does its own unconditional status write, already gated
   * by its own session-state check, immediately before calling this) and
   * the manual-arrived controller action (Task 10, which does an atomic
   * CONDITIONAL claim of that same status write before calling this) —
   * those two callers need different concurrency guarantees for the write
   * itself, so the write can't live in this shared method without collapsing
   * that difference. Keeping this method to "read the current state, tell
   * the customer" only is what lets both callers share it safely.
   */
  async notifyCustomerOperatorArrived(rescueRequestId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) return;
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 Your tow operator has arrived!\n\nBusiness: *${rescueRequest.assignedOperator?.businessName}*\n\nThey're at your location. Please show them your vehicle.`,
      );
    }
  }

  /**
   * The DONE-equivalent for a manual job — deliberately NOT gated on
   * completion media: a non-WhatsApp job is exempt from the mandatory
   * evidence rule by explicit product decision, verified by phone instead.
   * `handleOperatorJobDone` (the WhatsApp path) is completely untouched by
   * this method and still requires media first, exactly as today.
   *
   * Unlike `notifyCustomerOperatorArrived`, this one is NOT shared with any
   * WhatsApp-path method (the WhatsApp DONE flow has no manual-only
   * equivalent to share with), so it owns its own atomic conditional claim
   * end to end — the claim (`status: ARRIVED` AND `confirmationDueAt: null`
   * → sets `confirmationDueAt`) is the first statement inside its own
   * transaction, closing the claim race a status-only condition would leave
   * open (a second call re-claiming the same row and re-sending CONFIRM
   * indefinitely), self-contained, with no separate claim helper needed
   * elsewhere.
   *
   * No longer gated on `assignedOperator.whatsappEnabled: false` — the
   * controller now also permits a reasoned override for a WhatsApp-enabled
   * operator. `reason` is accepted purely so this method's call shape
   * matches that override path; the controller's own audit-log call is
   * what records it. When the override applies, this also resets whichever
   * session row is currently tracking this job for the assigned operator
   * to IDLE — the same state a real, unmasked DONE leaves the operator's
   * own session in (see the WhatsApp-path handler, same file) — so a later
   * reconnect doesn't act on stale pre-override state.
   */
  async startManualCompletionConfirmation(
    rescueRequestId: string,
    options?: { reason?: string },
  ): Promise<{ claimed: boolean }> {
    const hasReason = !!options?.reason;
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.ARRIVED,
          confirmationDueAt: null,
          // Without a reason, re-verify whatsappEnabled: false atomically
          // — see the identical note in
          // RescueRequestAdminService.claimManualArrived.
          ...(!hasReason && { assignedOperator: { whatsappEnabled: false } }),
        },
        data: {
          confirmationDueAt: new Date(Date.now() + STALLED_CONFIRMATION_MS),
        },
      });
      if (claimed.count === 0) return null;

      const rescueRequest = await tx.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: {
          customerId: true,
          customer: { select: { phoneNumber: true } },
          assignedOperatorId: true,
          assignedOperator: {
            select: {
              businessName: true,
              whatsappEnabled: true,
              phoneNumber: true,
            },
          },
        },
      });
      if (rescueRequest?.customerId) {
        await tx.whatsAppSession.updateMany({
          where: { userId: rescueRequest.customerId },
          data: {
            state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
            rescueRequestId,
          },
        });
      }
      if (
        rescueRequest?.assignedOperator?.whatsappEnabled &&
        rescueRequest.assignedOperator.phoneNumber
      ) {
        logger.info(
          'manual override: resetting WhatsApp-enabled operator session (DONE)',
          {
            rescueRequestId,
            operatorId: rescueRequest.assignedOperatorId,
            reason: options?.reason,
          },
        );
        // Matched by the operator's own on-file phoneNumber — see the
        // identical note in RescueRequestAdminService.claimManualArrived.
        await tx.whatsAppSession.updateMany({
          where: {
            rescueRequestId,
            user: { phoneNumber: rescueRequest.assignedOperator.phoneNumber },
          },
          data: { state: WhatsAppFlowState.IDLE, rescueRequestId: null },
        });
      }
      return rescueRequest;
    });

    if (!result) return { claimed: false };

    const customerPhone = result.customer?.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🔧 ${result.assignedOperator?.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
      );
    }
    return { claimed: true };
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
    if (
      !rescueRequest ||
      rescueRequest.status === RescueRequestStatus.CANCELLED ||
      rescueRequest.status === RescueRequestStatus.COMPLETED
    ) {
      logger.info('whatsapp: ARRIVED rejected — request already ended', {
        operatorId: operator.id,
        rescueRequestId,
        status: rescueRequest?.status ?? 'NOT_FOUND',
      });
      await this.sessionStore.clear(operatorUserId);
      return this.reply(
        `${formatJobRef(rescueRequestId)} has already ended. Watch out for new dispatch offers.`,
      );
    }

    // Update request status to ARRIVED — unconditional here, exactly as
    // before this task: this path's own session-state check above
    // (OPERATOR_ON_JOB) is what already guards this write; it does not need
    // the manual path's atomic conditional claim, which exists specifically
    // because the manual path has no session state to check instead.
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.ARRIVED },
    });

    // Operator session → AT_LOCATION
    await this.sessionStore.update(operatorUserId, {
      state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
    });

    await this.notifyCustomerOperatorArrived(rescueRequestId);

    // Full definition: TWILIO_CONTENT_TEMPLATES.done_prompt in
    // src/integrations/twilio/twilio-content-templates.ts.
    const donePromptSid = process.env.TWILIO_DONE_PROMPT_TEMPLATE_SID;
    const donePromptText = `✅ ${formatJobRef(rescueRequestId)} — Arrival confirmed! The customer has been notified.\n\nSend *DONE* when the job is complete.`;
    if (donePromptSid) {
      return this.replyWithTemplateOrText(
        await this.resolveOperatorReminderDestination(operatorUserId, {
          phoneNumber: operatorPhone,
        }),
        donePromptSid,
        { '1': formatJobRef(rescueRequestId) },
        donePromptText,
      );
    }
    return this.reply(donePromptText);
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
    if (
      !rescueRequest ||
      rescueRequest.status === RescueRequestStatus.CANCELLED ||
      rescueRequest.status === RescueRequestStatus.COMPLETED
    ) {
      await this.sessionStore.clear(operatorUserId);
      return this.reply(`${formatJobRef(rescueRequestId)} has already ended.`);
    }

    const customerPhone = rescueRequest.customer.phoneNumber;
    const customerId = rescueRequest.customerId;

    // The DONE transition is three writes, and all three must land together.
    //
    // confirmationDueAt is the only thing that will ever bring staff back to
    // this job: nothing else sets that column, so a write that fails — or a
    // process that dies between the writes — loses the alert permanently and
    // the customer's silence goes unnoticed. The two session moves are in
    // here for the same reason: an operator freed while the customer was
    // never asked to confirm, or the reverse, is a state no check repairs.
    //
    // Staff are alerted after 30 minutes; the job is never auto-completed.
    // By this point the vehicle has moved and the operator is waiting to be
    // paid, so forcing COMPLETED on nothing but silence would move money and
    // custody without confirmation. A quiet customer (dead phone, long tow,
    // simply busy) looks identical to one avoiding payment — only a human
    // can tell those apart. The job stays in AWAITING_COMPLETION_CONFIRM
    // until the customer responds or staff resolve it.
    await this.prisma.$transaction(async (tx) => {
      await tx.rescueRequest.update({
        where: { id: rescueRequestId },
        data: {
          confirmationDueAt: new Date(Date.now() + STALLED_CONFIRMATION_MS),
        },
      });
      if (customerId) {
        await tx.whatsAppSession.updateMany({
          where: { userId: customerId },
          data: {
            state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
            rescueRequestId,
          },
        });
      }
      // On the transaction client, not sessionStore — a clear on the default
      // client would commit independently and could survive a rollback of
      // the other two.
      await tx.whatsAppSession.updateMany({
        where: { userId: operatorUserId },
        data: { state: WhatsAppFlowState.IDLE, rescueRequestId: null },
      });
    });

    // Notification only after the commit, like every other in this design.
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🔧 ${operator.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
      );
    }

    return this.reply(
      `✅ Job marked as done! Waiting for customer confirmation.\n\nIf they confirm, you'll receive a notification. Thank you 🙏`,
    );
  }

  /**
   * Ends a masked chat relay for both sides at once — either party saying
   * END CHAT closes it for both, since there's no reason for one side to
   * keep relaying to someone who's already left.
   */
  private async endChatRelay(
    operatorUserId: string,
    operatorPhone: string,
    rescueRequestId: string | undefined,
  ): Promise<void> {
    await this.sessionStore.update(operatorUserId, { relayTarget: null });
    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(operatorPhone),
      `Chat ended.`,
    );

    if (!rescueRequestId) return;
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest?.customer) return;

    await this.sessionStore.update(rescueRequest.customerId, {
      relayTarget: null,
    });
    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppDestination(rescueRequest.customer),
      `Chat ended.`,
    );
  }

  private reply(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>${message}</Message>\n</Response>`;
  }

  /**
   * The ARRIVED/DONE reminders are sent via an async REST call, not a TwiML
   * reply, so they must target a reachable address explicitly rather than
   * relying on Twilio to route a reply back to whoever sent the inbound
   * webhook. Once this operator has ever been captured masked (a BSUID on
   * their linked User), prefer that over their on-file `operator.phoneNumber`
   * — Meta's own changelog documents outbound sends to a username-set
   * account needing the BSUID form, not the old phone number. Falls back to
   * the phone number when no BSUID has been captured, unchanged from before.
   */
  private async resolveOperatorReminderDestination(
    userId: string,
    operator: { phoneNumber: string },
  ): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { whatsappExternalUserId: true },
    });
    return user?.whatsappExternalUserId
      ? toWhatsAppDestination({
          phoneNumber: null,
          whatsappExternalUserId: user.whatsappExternalUserId,
        })
      : toWhatsAppDestination({
          phoneNumber: operator.phoneNumber,
          whatsappExternalUserId: null,
        });
  }

  private xmlOk(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  }

  /**
   * Sends a quick-reply Content Template (the only way to get a tap button
   * — TwiML has no contentSid) and acks the webhook empty. These prompts
   * are all in-session replies, so plain text always works: if Twilio
   * rejects the template, reply with `freeformText` over TwiML instead of
   * leaving the operator with nothing. TwilioService has already reported
   * the failure to Sentry with the Twilio code and SID.
   */
  private async replyWithTemplateOrText(
    to: string,
    contentSid: string,
    variables: Record<string, string>,
    freeformText: string,
  ): Promise<string> {
    try {
      await this.twilioService.sendWhatsAppTemplateMessage(
        to,
        contentSid,
        variables,
      );
      return this.xmlOk();
    } catch (error) {
      console.error(
        'whatsapp operator flow: template send failed, replying with freeform text instead:',
        { contentSid, error },
      );
      return this.reply(freeformText);
    }
  }
}
