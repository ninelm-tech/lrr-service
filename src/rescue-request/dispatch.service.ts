import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { toWhatsAppAddress } from '../common/phone.util';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { PrismaService } from '../prisma/prisma.service';
import { RescueRequestStatus, VehicleType } from '@prisma/client';
import { getEligibleTruckClasses, formatVehicleType } from './domain/vehicle-truck-mapping';
import { estimateEtaMinutes, rankQuotes } from './domain/quote-ranking';
import { formatJobRef, buildMediaLinksSection } from './domain/rescue-request-formatting';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { DispatchBoardRowDto } from './dto/rescue-request-response.dto';
import { RescueRequestSharedService } from './rescue-request-shared.service';

// ── Dispatch config ────────────────────────────────────────────────────────────
const BATCH_SIZE = 3;                  // operators offered per round simultaneously
const DISPATCH_RETRY_MINUTES         = Number(process.env.DISPATCH_RETRY_MINUTES  ?? 5);   // set to 1 in dev
const MAX_FAILED_ROUNDS_BEFORE_ALERT = Number(process.env.DISPATCH_MAX_ALERT_ROUND ?? 2);
const MAX_ROUNDS_BEFORE_AUTO_CANCEL  = Number(process.env.DISPATCH_MAX_ROUNDS     ?? 4);   // ~RETRY*MAX min total
const RADIUS_EXPANSION_KM = 2;

/**
 * WhatsApp rejects template *parameters* (not static body text) containing
 * newlines, tabs, or more than four consecutive spaces; Twilio surfaces
 * this as error 21656 — see https://www.twilio.com/docs/errors/21656.
 * Several of our values (distance+ETA, address+map link, media links) are
 * naturally multi-line, so collapse them onto a single line for the
 * template branch only. The freeform fallback keeps real line breaks.
 */
function sanitizeTemplateVariable(value: string): string {
  return value
    .trim()
    .replace(/[\t ]*[\r\n]+[\t ]*/g, ' · ')  // line breaks → visible separator
    .replace(/\t+/g, ' ')                     // stray tabs
    .replace(/ {2,}/g, ' ')                   // runs of spaces (4+ consecutive is rejected)
    .trim();
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly sharedService: RescueRequestSharedService,
  ) {}

  /**
   * Dispatch offers are business-initiated — WhatsApp only allows a
   * freeform body if the operator has messaged us within the last 24h,
   * which idle operators between jobs routinely won't have. On a real
   * (non-sandbox) number this MUST go through the approved
   * `dispatch_offer` Content Template — a freeform body gets rejected by
   * Meta (error 63016) outside a session window. Falls back to a freeform
   * send only when TWILIO_DISPATCH_OFFER_TEMPLATE_SID isn't configured
   * (e.g. local/sandbox testing before the template exists). Same pattern
   * as DisputeService.sendStaffDisputeAlert's TWILIO_DISPUTE_TEMPLATE_SID.
   */
  private async sendDispatchOfferMessage(
    operatorPhone: string,
    variables: {
      jobRef: string; vehicle: string; destination: string;
      /** '' or 'Distance: X km\n' — trailing newline included, absent when there's nothing to show (manualOfferToOperator). */
      distanceLine: string;
      location: string;
      /** '' or the '\n\n📎 Photos/Video/Audio:\n...' block from buildMediaLinksSection — used as-is. */
      mediaSection: string;
      /** '' or 'Est. ETA: ~N min based on your registered location.\n' — trailing newline included. */
      etaLine: string;
      window: string;
    },
  ): Promise<void> {
    const templateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
    const to = toWhatsAppAddress(operatorPhone);

    if (templateSid) {
      // Mapping is dictated by the live template (`new_rescue_job`), which
      // declares exactly SEVEN variables — verified against
      // GET https://content.twilio.com/v1/Content/{sid}. Two things that
      // trip you up if you eyeball the body instead:
      //   - there is no separate ETA slot; distance and ETA share {{4}}
      //   - the disambiguation line reuses {{1}}, it is NOT an 8th variable
      // Sending a key the template doesn't declare (e.g. '8') fails the
      // whole send with Twilio 21656 "The Content Variables parameter is
      // invalid" — it does not degrade gracefully or ignore extras.
      //
      // Every value also goes through sanitizeTemplateVariable: 21656 is
      // equally triggered by newlines/tabs inside a value, and by a value
      // that resolves to empty — hence the non-empty fallbacks below.
      const distanceEta = [variables.distanceLine.trim(), variables.etaLine.trim()]
        .filter(Boolean)
        .join('\n') || 'Distance: N/A';
      const templateVariables: Record<string, string> = {
        '1': variables.jobRef,
        '2': variables.vehicle,
        '3': variables.destination,
        '4': distanceEta,
        '5': variables.location,
        '6': variables.mediaSection.trim() || 'No photos, video, or audio attached.',
        '7': variables.window,
      };
      for (const key of Object.keys(templateVariables)) {
        templateVariables[key] = sanitizeTemplateVariable(templateVariables[key]) || '—';
      }
      await this.twilioService.sendWhatsAppTemplateMessage(to, templateSid, templateVariables);
    } else {
      // Matches the original freeform layout exactly: Distance sits right
      // after Destination (before Location); ETA is its own line after the
      // bid prompt (before "Reply NO") — do not reorder these to "tidy up"
      // the message, the wording/order is what's already familiar to operators.
      await this.twilioService.sendWhatsAppMessage(
        to,
        `🚨 *NEW RESCUE JOB* — Job #${variables.jobRef}\n\nVehicle: ${variables.vehicle}\nDestination: ${variables.destination}\n${variables.distanceLine}Location: ${variables.location}${variables.mediaSection}\n\n⚠️ *ACTION NEEDED* — reply with your price to bid, e.g. "25000".\n${variables.etaLine}Reply *NO* to decline.\nYou have ${variables.window} to respond.\n\n📌 If you have more than one job open at once, reply "${variables.jobRef} 25000" instead of just the price, so we know which job you mean.`,
      );
    }
  }

  /**
   * In-memory map from BATCH to that batch's pending window timer.
   * Doubles as a simple single-process mutex: whichever code path (the
   * timer firing, or an operator's response completing the batch early)
   * finds and deletes the entry first is the one that resolves the batch;
   * the other finds it already gone and returns immediately. Fine for a
   * single-instance pilot deployment — not a distributed lock.
   *
   * Keyed per batch (`requestId:expiresAt`), NOT per request. This is load
   * bearing: a request can have several batches in flight at once, because
   * expanding the radius adds operators without cancelling the offers other
   * operators are still holding. With a per-request key the second batch
   * overwrote the first's entry, the orphaned timer later fired, and
   * resolveBatch ran with the OLD batch's operator list against the NEW
   * batch's state.
   *
   * supersedeActiveRound used to avoid that collision by cancelling every
   * pending offer so only one batch was ever live — i.e. by destroying the
   * work of operators who simply hadn't answered yet. It was deleted along
   * with this change; the two go together. If a stale-timer symptom ever
   * reappears, fix it here in the key, never by cancelling offers.
   * See docs/superpowers/specs/2026-08-24-dispatch-parallel-batches-design.md
   */
  private readonly batchTimers = new Map<string, NodeJS.Timeout>();

  /** `requestId:expiresAt` — see batchTimers. */
  private batchKey(rescueRequestId: string, batchExpiresAt: Date): string {
    return `${rescueRequestId}:${batchExpiresAt.getTime()}`;
  }

  /**
   * Pending "try another round after DISPATCH_RETRY_MINUTES" timers, one per
   * request. Separate from batchTimers because a retry belongs to no batch —
   * it exists precisely because the last round produced no candidates. Cleared
   * before being replaced so a request can't accumulate retries.
   */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  /**
   * In-memory map from rescueRequestId to a short grace-period timer, started
   * the moment the FIRST quote in a batch arrives. If the rest of the batch
   * stays silent, we don't make the motorist wait out the full window for a
   * shortlist that already has a usable quote — resolveBatch fires early with
   * whatever quotes exist. Guarded by the same batchTimers mutex inside
   * resolveBatch/supersedeActiveRound.
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly QUOTE_GRACE_MS = 5 * 60 * 1000;
  private readonly QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;

  /**
   * Channel-agnostic core: an operator submitted a price (quote) or declined
   * a specific PENDING offer. `quotedPriceKobo` is undefined for a decline.
   * Used by both the WhatsApp reply handler and the dashboard quote
   * endpoint — the only thing that differs between channels is how the
   * caller resolves `offer` in the first place.
   */
  async processQuoteOrDecline(
    offer: { id: string; rescueRequestId: string; expiresAt: Date },
    quotedPriceKobo: number | undefined,
  ): Promise<{ quoted: boolean; message: string }> {
    if (quotedPriceKobo === undefined) {
      await this.prisma.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      logger.info('dispatch: offer declined', { rescueRequestId: offer.rescueRequestId, offerId: offer.id });
      await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);
      return { quoted: false, message: `Understood — ${formatJobRef(offer.rescueRequestId)} declined. We'll offer this job to another operator.` };
    }

    await this.prisma.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: 'QUOTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
    });
    logger.info('dispatch: offer quoted', { rescueRequestId: offer.rescueRequestId, offerId: offer.id, quotedPriceKobo });
    await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);
    this.scheduleGraceResolve(offer.rescueRequestId, offer.expiresAt);

    return {
      quoted: true,
      message: `✅ Quote of ₦${(quotedPriceKobo / 100).toLocaleString()} submitted for ${formatJobRef(offer.rescueRequestId)}! We'll notify you if you're selected.`,
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

    void this.notifyPendingOperatorsOfCountdown(rescueRequestId, batchExpiresAt);

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
      void this.resolveBatch(rescueRequestId, batchOffers.map((o) => o.operatorId), rescueRequest.customerId, 0, batchExpiresAt);
    }, this.QUOTE_GRACE_MS);

    this.graceTimers.set(rescueRequestId, timer);
  }

  /**
   * Tells the rest of the batch a countdown has started, so a silent
   * operator knows why the job might close sooner than the original
   * response-window estimate — without this they'd have no signal that
   * someone else already bid.
   */
  private async notifyPendingOperatorsOfCountdown(rescueRequestId: string, batchExpiresAt: Date) {
    const stillPending = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, expiresAt: batchExpiresAt, status: 'PENDING' },
      include: { operator: true },
    });
    if (stillPending.length === 0) return;

    const graceMinutes = Math.round(this.QUOTE_GRACE_MS / 60000);
    await Promise.all(
      stillPending.map((offer) =>
        this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(offer.operator.phoneNumber),
          `⏱ *Countdown started* — ${formatJobRef(rescueRequestId)}\n\nAnother operator just placed a bid. You have *${graceMinutes} minute${graceMinutes === 1 ? '' : 's'}* left to submit your price if you still want this job.`,
        ),
      ),
    );
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

    logger.info('dispatch: candidate search', {
      rescueRequestId, round, radiusExpansionKm: extraRadiusKm,
      alreadyOfferedOperatorIds: alreadyOffered,
      candidateCount: candidates.length,
      candidateIds: candidates.map((c) => c.id),
    });

    if (candidates.length === 0) {
      // Fast-fail: check if there are ANY active operators near this location
      // (ignoring isAvailable — counts operators who switched themselves off).
      // If zero, it's a geography/coverage gap — retrying with an expanded
      // radius won't help, so cancel immediately rather than making the
      // customer wait 15-20 minutes for the same result.
      //
      // ~1.5° ≈ 150 km bounding box — larger than any realistic service radius,
      // so this covers the maximum possible expansion area upfront.
      const COVERAGE_DELTA_DEG = 1.5;
      const nearbyOperatorCount = await this.prisma.operator.count({
        where: {
          status: 'ACTIVE',           // isAvailable intentionally omitted (see findAndRankCandidates)
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
            `😔 Sorry, there are no tow operators available in your area at the moment.\n\nYour request has been cancelled.\n\nPlease try again later or call your breakdown provider.`,
          );
        }
        await this.alertAdminNoOperator(rescueRequestId, lat, lon, 0);
        return;
      }

      // Operators exist in the area but are currently busy or offline —
      // proceed with the normal retry + radius-expansion cycle.
      const newRound = round + 1;
      // offeredOperatorIds is deliberately NOT reset here. It used to be, so
      // that timed-out operators could be re-offered after the retry delay —
      // but combined with resolveBatch's tail call into startDispatch that
      // formed a loop: no candidates (everyone already offered) → reset →
      // the same operators become eligible → the same job is offered to them
      // again, round after round, until MAX_ROUNDS_BEFORE_AUTO_CANCEL.
      // Observed on staging 2026-08-24: an operator received one job
      // repeatedly and could still quote on it after it had apparently ended.
      //
      // Once an operator has been asked, they have been asked. The radius
      // expansion below is what finds new people.
      await this.sessionStore.update(customerId, { dispatchRound: newRound });

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
            `😔 We're sorry — no tow operator was available near you after an extended search.\n\nYour request has been automatically cancelled.\n\nPlease try again shortly or call your breakdown cover provider.`,
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
      const retryTimer = setTimeout(
        () => {
          this.retryTimers.delete(rescueRequestId);
          void this.startDispatch(rescueRequestId, customerId, expandedRadius);
        },
        DISPATCH_RETRY_MINUTES * 60 * 1000,
      );
      // Clear before replacing — the previous code stored this in batchTimers
      // with a plain set(), so an overwritten retry timer still fired.
      const priorRetry = this.retryTimers.get(rescueRequestId);
      if (priorRetry) clearTimeout(priorRetry);
      this.retryTimers.set(rescueRequestId, retryTimer);
      return;
    }

    // Take the next batch of top-ranked candidates
    const batch = candidates.slice(0, BATCH_SIZE);
    const batchOperatorIds = batch.map((op) => op.id);

    logger.info('dispatch: batch offered', {
      rescueRequestId, round, radiusExpansionKm: extraRadiusKm,
      offered: batch.map((op) => ({ operatorId: op.id, businessName: op.businessName, distanceKm: Number(op.distance.toFixed(1)) })),
    });

    const config = await this.platformConfigService.getConfig();
    const windowSeconds = config.dispatchWindowMinutes * 60;
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
    const mediaSection = buildMediaLinksSection(mediaItems);
    const locationSection = await this.sharedService.formatLocationSection(lat, lon);

    // Notify all batch operators simultaneously. allSettled (not all) —
    // one operator's send failing (e.g. Twilio 63016, no open session with
    // them) must not prevent the others in the same batch from being
    // notified, and must not throw an unhandled rejection out of this
    // fire-and-forget dispatch round.
    const jobRef = formatJobRef(rescueRequestId);
    const sendResults = await Promise.allSettled(
      batch.map((op) =>
        this.sendDispatchOfferMessage(op.phoneNumber, {
          jobRef: jobRef.replace('Job #', ''),
          vehicle: vehicleLabel,
          destination: destinationLabel,
          distanceLine: `Distance: ${op.distance.toFixed(1)} km\n`,
          location: locationSection,
          mediaSection,
          etaLine: `Est. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.\n`,
          window: `${config.dispatchWindowMinutes} minute${config.dispatchWindowMinutes === 1 ? '' : 's'}`,
        }),
      ),
    );
    sendResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        const op = batch[i];
        console.error(`Failed to send dispatch offer to operator ${op.id}:`, result.reason);
        Sentry.captureException(result.reason, { extra: { rescueRequestId, operatorId: op.id } });
      }
    });

    // Single timeout covers the entire batch — stored so an early-resolved
    // batch (Step below) can prevent this from firing a second time.
    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm, expiresAt),
      windowSeconds * 1000,
    );
    this.batchTimers.set(this.batchKey(rescueRequestId, expiresAt), timer);
  }

  private async resolveBatch(
    rescueRequestId: string,
    batchOperatorIds: string[],
    customerId: string,
    extraRadiusKm: number,
    batchExpiresAt: Date,
  ) {
    // Mutex: only the caller that finds (and removes) the timer entry proceeds.
    // Scoped to THIS batch — another batch of the same request resolving must
    // not consume this one's entry.
    const key = this.batchKey(rescueRequestId, batchExpiresAt);
    const timer = this.batchTimers.get(key);
    if (!timer) return; // already resolved by the other path
    clearTimeout(timer);
    this.batchTimers.delete(key);

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
    void this.resolveBatch(rescueRequestId, batchOperatorIds, rescueRequest.customerId, 0, batchExpiresAt);
  }

  //
  // supersedeActiveRound used to live here. It cancelled every PENDING offer
  // on a request so an admin-initiated round could take over "the round slot",
  // because batchTimers was keyed per request and a second batch would
  // otherwise clobber the first's entry.
  //
  // It bought that safety by destroying other operators' work: an operator two
  // minutes into a ten-minute window lost the offer because an admin clicked
  // Expand — asked a question and never allowed to answer. Expanding the
  // radius means "also ask these people", never "un-ask those people".
  //
  // Per-batch timer keys (see batchTimers) remove the collision it existed to
  // prevent, so it is gone. Do not restore it, and do not add any other
  // blanket PENDING → TIMED_OUT sweep scoped to a whole request. An offer ends
  // when the operator answers it or when its own expiresAt passes.
  //

  /**
   * Admin action: immediately start a new dispatch round with an expanded
   * radius, instead of waiting for the automatic DISPATCH_RETRY_MINUTES
   * timer. extraRadiusKm isn't persisted between rounds (see the comment
   * on maybeResolveBatchEarly's callers), so the current radius is
   * approximated from the session's dispatchRound — the same
   * approximation the automatic retry path already effectively produces.
   */
  async expandRadiusNow(rescueRequestId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest || rescueRequest.status !== RescueRequestStatus.DISPATCHING) {
      throw new BadRequestException('Request is not currently DISPATCHING');
    }

    // Deliberately does NOT touch existing offers — operators still inside
    // their window keep them. Expanding adds people; it never un-asks anyone.
    const session = await this.sessionStore.getOrCreate(rescueRequest.customerId);
    const currentRadius = (session.dispatchRound ?? 0) * RADIUS_EXPANSION_KM;
    const expandedRadius = currentRadius + RADIUS_EXPANSION_KM;

    void this.startDispatch(rescueRequestId, rescueRequest.customerId, expandedRadius);
  }

  /**
   * Admin action: offer this job directly to one specific operator,
   * bypassing findAndRankCandidates entirely. Implemented as an ordinary
   * single-operator dispatch round — the offer's expiresAt drives the same
   * processQuoteOrDecline/maybeResolveBatchEarly machinery every other
   * round uses, so no bespoke quote-handling is needed here.
   */
  async manualOfferToOperator(rescueRequestId: string, operatorId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest || rescueRequest.status !== RescueRequestStatus.DISPATCHING) {
      throw new BadRequestException('Request is not currently DISPATCHING');
    }

    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator || operator.status !== 'ACTIVE') {
      throw new BadRequestException('Target is not an active operator');
    }

    // As with expandRadiusNow: existing offers are left alone. This adds one
    // more operator to the request, it does not replace the current round.
    const MANUAL_OFFER_WINDOW_MS = 5 * 60 * 1000;
    const expiresAt = new Date(Date.now() + MANUAL_OFFER_WINDOW_MS);

    await this.prisma.dispatchOffer.create({
      data: { rescueRequestId, operatorId, expiresAt },
    });

    // Append, never replace — every other call site that touches
    // offeredOperatorIds spreads the existing list first (see e.g.
    // startDispatch's batch-tracking update); replacing it here would let
    // operators from earlier rounds become eligible for re-offering again.
    const session = await this.sessionStore.getOrCreate(rescueRequest.customerId);
    await this.sessionStore.update(rescueRequest.customerId, {
      offeredOperatorIds: [...(session.offeredOperatorIds ?? []), operatorId],
    });

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);
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
    const mediaSection = buildMediaLinksSection(mediaItems);
    const locationSection = await this.sharedService.formatLocationSection(lat, lon);

    try {
      await this.sendDispatchOfferMessage(operator.phoneNumber, {
        jobRef: formatJobRef(rescueRequestId).replace('Job #', ''),
        vehicle: vehicleLabel,
        destination: destinationLabel,
        distanceLine: '', // not computed for a manual single-operator offer
        location: locationSection,
        mediaSection,
        etaLine: '', // not computed for a manual single-operator offer
        window: '5 minutes',
      });
    } catch (error) {
      // Unlike the batch path (allSettled — a failed send must not block
      // the other operators in the round), this is a single admin-triggered
      // offer: the admin needs to see it failed, so re-throw after logging
      // for visibility — don't silently succeed.
      console.error(`Failed to send manual dispatch offer to operator ${operatorId}:`, error);
      Sentry.captureException(error, { extra: { rescueRequestId, operatorId } });
      throw error;
    }

    const currentRadius = (session.dispatchRound ?? 0) * RADIUS_EXPANSION_KM;
    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, [operatorId], rescueRequest.customerId, currentRadius, expiresAt),
      MANUAL_OFFER_WINDOW_MS,
    );
    this.batchTimers.set(this.batchKey(rescueRequestId, expiresAt), timer);
  }

  async sendQuoteShortlist(rescueRequestId: string, customerId: string) {
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
      // This must exactly match what handleQuoteSelected later charges, so the
      // motorist never sees one number here and a different one at payment.
      const displayTotal = q.quotedPrice + Math.round((q.quotedPrice * config.serviceFeePercent) / 100);
      const priceNaira = (displayTotal / 100).toLocaleString();
      return `${numberEmoji} ₦${priceNaira} · ETA ${q.etaMinutes} min · ${q.businessName}`;
    });

    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 *Operator quotes received!*\n\n${lines.join('\n')}\n\n⚠️ *ACTION NEEDED* — reply with the number of your choice (e.g. "1") to select an operator.`,
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
            `⏰ ${formatJobRef(rescueRequestId)} is no longer available — the customer didn't choose a quote in time. Watch for new offers!`,
          ),
        ),
      );
    }, this.QUOTE_SELECTION_WINDOW_MS);
  }

  // ══════════════════════════════════════════════════════
  //  OFFER RESPONSE — channel-agnostic core
  //  Used by both the WhatsApp handler and the dashboard API.
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
  //  DISPATCH BOARD (admin ops view)
  // ══════════════════════════════════════════════════════

  async getDispatchBoard(): Promise<DispatchBoardRowDto[]> {
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);

    const requests = await this.prisma.rescueRequest.findMany({
      where: {
        OR: [
          { status: RescueRequestStatus.DISPATCHING },
          {
            status: { in: [RescueRequestStatus.OPERATOR_ASSIGNED, RescueRequestStatus.CANCELLED] },
            updatedAt: { gte: sixtyMinAgo },
          },
        ],
      },
      include: {
        dispatchOffers: {
          include: { operator: { select: { businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const customerIds = [...new Set(requests.map((r) => r.customerId))];
    const sessions = await this.prisma.whatsAppSession.findMany({
      where: { userId: { in: customerIds } },
      select: { userId: true, dispatchRound: true },
    });
    const roundByCustomerId = new Map(sessions.map((s) => [s.userId, s.dispatchRound]));

    return requests.map((r) => ({
      id: r.id,
      status: r.status,
      vehicleType: r.vehicleType ?? undefined,
      destination: r.destination ?? undefined,
      round: roundByCustomerId.get(r.customerId) ?? 0,
      createdAt: r.createdAt,
      offers: r.dispatchOffers.map((o) => ({
        operatorId: o.operatorId,
        businessName: o.operator.businessName,
        status: o.status,
        quotedPrice: o.quotedPrice ?? undefined,
        offeredAt: o.offeredAt,
        respondedAt: o.respondedAt ?? undefined,
      })),
    }));
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
}
