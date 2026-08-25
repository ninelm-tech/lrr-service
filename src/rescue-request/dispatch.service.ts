import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
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

  /** `requestId:batchId` — see batchTimers. */
  private batchKey(rescueRequestId: string, batchId: string): string {
    return `${rescueRequestId}:${batchId}`;
  }

  /**
   * Phase 2 close timers, one per request, started when the FIRST quote sets
   * `quoteCollectionDeadline`. Replaces the old `graceTimers`/`QUOTE_GRACE_MS`
   * pair: that was a batch-scoped grace period that competed with batch
   * expiry, this is the single request-level ceiling.
   *
   * The timer is a CEILING on stragglers, not a mandatory wait —
   * `maybeResolveBatchEarly` still closes bidding the moment nothing is
   * pending, and `closeBidding` clears this entry when it does.
   */
  private readonly closeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Requests whose bidding has already closed (shortlist sent). In-process
   * only, like every other timer/mutex in this service — durability across
   * restarts is explicitly out of scope for this spec.
   *
   * Needed on top of the `quoteCollectionDeadline` check because bidding can
   * close EARLY (everyone answered before the deadline). Between an early
   * close and the deadline the persisted deadline still reads "in future", so
   * without this a quote on an admin-added offer in that gap would be recorded
   * as QUOTED and never appear on the shortlist the motorist already has.
   */
  private readonly closedRequests = new Set<string>();

  private readonly QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;

  /**
   * Channel-agnostic core: an operator submitted a price (quote) or declined
   * a specific PENDING offer. `quotedPriceKobo` is undefined for a decline.
   * Used by both the WhatsApp reply handler and the dashboard quote
   * endpoint — the only thing that differs between channels is how the
   * caller resolves `offer` in the first place.
   */
  async processQuoteOrDecline(
    offer: { id: string; rescueRequestId: string; expiresAt: Date; batchId: string },
    quotedPriceKobo: number | undefined,
  ): Promise<{ quoted: boolean; message: string }> {
    const isDecline = quotedPriceKobo === undefined;

    // Bidding already closed: the shortlist is with the motorist, so this
    // price can never be ranked into it. Record it as NOT_SELECTED (never
    // QUOTED — that would silently add it to a list already shown) and tell
    // the operator what actually happened rather than "quote submitted".
    // Checked BEFORE the atomic claim below, because after a deadline close
    // the offer's expiresAt has also passed and the claim would otherwise
    // return the generic "expired" message.
    if (!isDecline && (await this.isBiddingClosed(offer.rescueRequestId))) {
      await this.prisma.dispatchOffer.updateMany({
        where: { id: offer.id, status: 'PENDING' },
        data: { status: 'NOT_SELECTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
      });
      logger.info('dispatch: quote arrived after bidding closed', {
        rescueRequestId: offer.rescueRequestId, offerId: offer.id, quotedPriceKobo,
      });
      return {
        quoted: false,
        message: `⌛ Bidding has already closed for ${formatJobRef(offer.rescueRequestId)} — the customer is choosing from the quotes received. Thanks for responding; watch for new offers!`,
      };
    }

    // Atomic claim. Status-check-then-update left a real gap between an
    // offer's expiresAt passing and something marking it TIMED_OUT (batch
    // timer, phase-2 close, or the sweeper), and a quote accepted inside that
    // gap is exactly what starts phase 2 or reorders a shortlist. The
    // conditional write is where the guarantee has to live, because both the
    // WhatsApp and dashboard channels funnel through here.
    const claimed = await this.prisma.dispatchOffer.updateMany({
      where: { id: offer.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: {
        status: isDecline ? 'DECLINED' : 'QUOTED',
        quotedPrice: quotedPriceKobo,
        respondedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      return { quoted: false, message: `Sorry, that offer has expired.` };
    }

    if (isDecline) {
      logger.info('dispatch: offer declined', { rescueRequestId: offer.rescueRequestId, offerId: offer.id });
      await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.batchId);
      return { quoted: false, message: `Understood — ${formatJobRef(offer.rescueRequestId)} declined. We'll offer this job to another operator.` };
    }

    logger.info('dispatch: offer quoted', { rescueRequestId: offer.rescueRequestId, offerId: offer.id, quotedPriceKobo });
    // Order matters: phase 2 must have started (deadline persisted) before
    // maybeResolveBatchEarly runs, or the early check would still be
    // batch-scoped and could resolve one batch while others are pending.
    await this.beginQuoteCollectionIfFirst(offer.rescueRequestId);
    await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.batchId);

    return {
      quoted: true,
      message: `✅ Quote of ₦${(quotedPriceKobo / 100).toLocaleString()} submitted for ${formatJobRef(offer.rescueRequestId)}! We'll notify you if you're selected.`,
    };
  }

  /** True once the shortlist has gone out, or once the deadline has passed. */
  private async isBiddingClosed(rescueRequestId: string): Promise<boolean> {
    if (this.closedRequests.has(rescueRequestId)) return true;
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { quoteCollectionDeadline: true },
    });
    const deadline = rescueRequest?.quoteCollectionDeadline;
    return !!deadline && Date.now() >= deadline.getTime();
  }

  /**
   * Phase 1 → phase 2. Called on every accepted quote; only the FIRST one
   * does anything.
   *
   * The set is an atomic `updateMany` conditioned on
   * `quoteCollectionDeadline: null`, deliberately NOT read-then-write: two
   * operators quoting simultaneously would each compute their own deadline
   * and the later write would win, silently pushing the stranded motorist's
   * wait further out. That is the one invariant this whole phase exists to
   * protect — once set, nothing (a second quote, an admin Expand, a new
   * batch) may ever move this deadline later.
   */
  private async beginQuoteCollectionIfFirst(rescueRequestId: string): Promise<void> {
    const config = await this.platformConfigService.getConfig();
    const quoteCollectionMs = config.quoteCollectionMinutes * 60 * 1000;
    const deadline = new Date(Date.now() + quoteCollectionMs);

    const started = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequestId, quoteCollectionDeadline: null },
      data: { quoteCollectionDeadline: deadline },
    });
    if (started.count === 0) return; // phase 2 already running — leave it alone

    logger.info('dispatch: quote collection started', { rescueRequestId, deadline });

    // Every still-pending offer now ends at the deadline instead of its own
    // batch window. Rewriting expiresAt (rather than deriving a min() at each
    // read) keeps expiresAt the single authority — the operator flow lookup,
    // listMyPendingOffers and the sweeper all consult it and would each need
    // the clamp otherwise. `gt: deadline` so a shorter window is never
    // lengthened.
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'PENDING', expiresAt: { gt: deadline } },
      data: { expiresAt: deadline },
    });

    await this.notifyPendingOperatorsOfCountdown(rescueRequestId, deadline);

    // Scheduled off the DEADLINE, not off `quoteCollectionMs`: the countdown
    // notify above is N Twilio round-trips, and a full-window delay measured
    // from after those sends fires at deadline + notify-latency, pushing the
    // motorist's shortlist out by however long WhatsApp took. Same reason the
    // batch timers are scheduled from their offers' expiresAt.
    const timer = setTimeout(() => {
      this.closeTimers.delete(rescueRequestId);
      void this.closeBidding(rescueRequestId);
    }, Math.max(0, deadline.getTime() - Date.now()));
    this.closeTimers.set(rescueRequestId, timer);
  }

  /**
   * Tells everyone still pending on the request that the countdown has
   * started, so a silent operator knows why the job may close sooner than
   * the response window they were originally quoted.
   *
   * Request-scoped, not batch-scoped: phase 2 shortened EVERY pending offer,
   * including ones from other batches, so every one of those operators needs
   * telling.
   *
   * Sent via a Content Template when TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID is
   * configured — same env-gated fallback as sendDispatchOfferMessage. This is
   * not optional politeness in production: the recipients are by definition
   * the operators who have NOT replied, i.e. exactly the ones least likely to
   * have an open 24-hour session, so a freeform body hits Twilio 63016 for
   * precisely its intended audience.
   */
  private async notifyPendingOperatorsOfCountdown(rescueRequestId: string, deadline: Date) {
    const stillPending = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'PENDING' },
      include: { operator: true },
    });
    if (stillPending.length === 0) return;

    const remaining = this.formatRemaining(deadline);
    const templateSid = process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
    const jobRef = formatJobRef(rescueRequestId).replace('Job #', '');

    // One send failing (no open session, bad number) must not stop the rest
    // of the pending operators being told — same reason startDispatch uses
    // allSettled for the batch offer.
    const results = await Promise.allSettled(
      stillPending.map((offer) => {
        const to = toWhatsAppAddress(offer.operator.phoneNumber);
        if (templateSid) {
          // Two declared variables. Values are sanitized and given non-empty
          // fallbacks for the same reason the dispatch-offer template does:
          // an empty value, a newline, a tab or 4+ consecutive spaces inside
          // a variable fails the entire send with Twilio 21656. The template
          // body must wrap both — it may never start or end with a variable.
          const variables: Record<string, string> = {
            '1': sanitizeTemplateVariable(jobRef) || '—',
            '2': sanitizeTemplateVariable(remaining) || '—',
          };
          return this.twilioService.sendWhatsAppTemplateMessage(to, templateSid, variables);
        }
        return this.twilioService.sendWhatsAppMessage(
          to,
          `⏱ *Countdown started* — ${formatJobRef(rescueRequestId)}\n\nAnother operator just placed a bid. You have *${remaining}* left to submit your price if you still want this job.`,
        );
      }),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`Failed to send countdown notice to operator ${stillPending[i].operatorId}:`, result.reason);
        Sentry.captureException(result.reason, {
          extra: { rescueRequestId, operatorId: stillPending[i].operatorId },
        });
      }
    });
  }

  /**
   * Human-readable time left until `until`, in whole minutes (rounded up).
   * Used both for the countdown notice and for the "You have N to respond"
   * line on an offer — an offer created late in phase 2 may have well under
   * a minute, and its message must reflect that rather than repeating the
   * configured window.
   */
  private formatRemaining(until: Date): string {
    const ms = Math.max(0, until.getTime() - Date.now());
    // Minutes only — no seconds granularity in operator-facing messages.
    // Always rounds UP, never down: a lie in the generous direction ("1
    // minute" when 20 seconds remain) costs nothing, but rounding down
    // would understate the true deadline and could read as inviting a
    // reply after it's actually passed. Floors at 1 so this never renders
    // "0 minutes".
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  /**
   * An offer's expiry, never later than the request's quote-collection
   * deadline.
   *
   * The deadline is re-read HERE, immediately before the write, and never
   * taken from a value the caller read earlier: finding candidates takes real
   * time, and a first quote can land — starting phase 2 — in that gap. An
   * offer created after that point with a full window would escape the
   * expiresAt rewrite entirely and outlive the deadline it should have been
   * clamped to.
   */
  private async offerExpiryClampedToDeadline(rescueRequestId: string, windowMs: number): Promise<Date> {
    const fresh = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { quoteCollectionDeadline: true },
    });
    const deadline = fresh?.quoteCollectionDeadline ?? null;
    const now = Date.now();
    return deadline
      ? new Date(Math.min(now + windowMs, deadline.getTime()))
      : new Date(now + windowMs);
  }

  /**
   * Bidding is over: no further quote can join the shortlist. Marks whatever
   * is still PENDING as TIMED_OUT, then sends the ranked shortlist.
   *
   * The single place both close triggers funnel through — the
   * quoteCollectionDeadline timer, and maybeResolveBatchEarly when nothing is
   * left pending. Idempotent: whichever gets here first wins and the other
   * returns immediately.
   *
   * This is the one request-wide PENDING → TIMED_OUT sweep the design allows
   * (see the supersedeActiveRound note below). It is legitimate precisely
   * because bidding has ended for everyone at once; it is NOT a licence to
   * add other request-scoped sweeps.
   */
  private async closeBidding(rescueRequestId: string): Promise<void> {
    const closeTimer = this.closeTimers.get(rescueRequestId);
    if (closeTimer) {
      clearTimeout(closeTimer);
      this.closeTimers.delete(rescueRequestId);
    }
    if (this.closedRequests.has(rescueRequestId)) return;

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { status: true, customerId: true },
    });
    if (
      !rescueRequest ||
      rescueRequest.status === RescueRequestStatus.OPERATOR_ASSIGNED ||
      rescueRequest.status === RescueRequestStatus.WAITING_FOR_DEPOSIT ||
      rescueRequest.status === RescueRequestStatus.COMPLETED ||
      rescueRequest.status === RescueRequestStatus.CANCELLED
    ) return;

    this.closedRequests.add(rescueRequestId);

    // Any batch timer still outstanding for this request belongs to a batch
    // whose offers have just been closed. Left alone it would later fire
    // resolveBatch, find QUOTED offers and send the motorist a SECOND
    // shortlist. Drain them here.
    for (const [key, timer] of this.batchTimers) {
      if (key.startsWith(`${rescueRequestId}:`)) {
        clearTimeout(timer);
        this.batchTimers.delete(key);
      }
    }

    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });

    logger.info('dispatch: bidding closed', { rescueRequestId });
    await this.sendQuoteShortlist(rescueRequestId, rescueRequest.customerId);
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

    const config = await this.platformConfigService.getConfig();

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
      // Never auto-cancel a request that already has a usable quote sitting
      // on it. resolveBatch's own tail into startDispatch already checks
      // this (it only reaches here with zero quotes), but expandRadiusNow
      // calls startDispatch directly and has no such check of its own — an
      // admin expanding the radius on a request that already has quotes
      // would otherwise run this exact "no candidates found" logic all the
      // way to auto-cancel, discarding real quotes. Confirmed on staging
      // (Sentry LRR-SERVICE-5): "Auto-cancelled: no operator after 4 rounds"
      // fired from POST /rescue-requests/:id/expand-radius while the request
      // had 2 valid QUOTED offers.
      const quotedOffers = await this.prisma.dispatchOffer.findMany({
        where: { rescueRequestId, status: 'QUOTED' },
      });
      if (quotedOffers.length > 0) {
        await this.sendQuoteShortlist(rescueRequestId, customerId);
        return;
      }

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

      // No timer: expand the radius and try the next batch immediately, in
      // the same tick. The old DISPATCH_RETRY_MINUTES delay just made a
      // stranded motorist wait longer for no benefit — untried candidates
      // (or a wider radius) are either there now or they aren't.
      const expandedRadius = extraRadiusKm + RADIUS_EXPANSION_KM;
      void this.startDispatch(rescueRequestId, customerId, expandedRadius);
      return;
    }

    // Take the next batch of top-ranked candidates
    const batch = candidates.slice(0, config.dispatchBatchSize);
    const batchOperatorIds = batch.map((op) => op.id);

    logger.info('dispatch: batch offered', {
      rescueRequestId, round, radiusExpansionKm: extraRadiusKm,
      offered: batch.map((op) => ({ operatorId: op.id, businessName: op.businessName, distanceKm: Number(op.distance.toFixed(1)) })),
    });

    // Clamped against a deadline read right now — a first quote may have
    // landed while findAndRankCandidates was running.
    const windowMs = config.dispatchWindowMinutes * 60 * 1000;
    const expiresAt = await this.offerExpiryClampedToDeadline(rescueRequestId, windowMs);
    const batchId = crypto.randomUUID();

    // Re-check right before the write. expandRadiusNow checks
    // assertBiddingStillOpen up front but then fires this method off
    // unawaited (`void this.startDispatch(...)`) — the real write happens
    // after findAndRankCandidates, well after that guard ran. An early close
    // (closeBidding, triggered by the last outstanding offer being answered)
    // can land in that window, so guard again here, silently, the same way
    // the other early-return branches above do — this is reached from
    // several fire-and-forget call sites and must not throw an unhandled
    // rejection.
    if (this.closedRequests.has(rescueRequestId)) return;

    // Create all offers in one batch insert
    await this.prisma.dispatchOffer.createMany({
      data: batch.map((op) => ({
        rescueRequestId,
        operatorId: op.id,
        expiresAt,
        batchId,
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
          // From the offer's ACTUAL expiry, not the configured window: an
          // offer created inside phase 2 may only have ninety seconds, and
          // the message must not claim otherwise.
          window: this.formatRemaining(expiresAt),
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
    // batch (Step below) can prevent this from firing a second time. Fires
    // when the offers actually expire, which is earlier than the full window
    // if they were clamped to the quote-collection deadline.
    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm, batchId),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    this.batchTimers.set(this.batchKey(rescueRequestId, batchId), timer);
  }

  private async resolveBatch(
    rescueRequestId: string,
    batchOperatorIds: string[],
    customerId: string,
    extraRadiusKm: number,
    batchId: string,
  ) {
    // Mutex: only the caller that finds (and removes) the timer entry proceeds.
    // Scoped to THIS batch — another batch of the same request resolving must
    // not consume this one's entry.
    const key = this.batchKey(rescueRequestId, batchId);
    const timer = this.batchTimers.get(key);
    if (!timer) return; // already resolved by the other path
    clearTimeout(timer);
    this.batchTimers.delete(key);

    // Bidding already closed for the whole request — the shortlist has gone
    // out. Resolving a batch now would send the motorist a second one.
    if (this.closedRequests.has(rescueRequestId)) return;

    // Race condition guard — skip if the request moved on for any other reason
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { status: true, quoteCollectionDeadline: true },
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

    // No quotes at all this round. This is phase 1's automatic continuation
    // path — it must go quiet the moment phase 2 starts (quoteCollectionDeadline
    // set), even though bidding itself stays open through the end of phase 2.
    // Once phase 2 has started, closeBidding/the deadline timer from Tasks
    // 4-6 already owns what happens next; admin-initiated continuation
    // (expandRadiusNow, manualOfferToOperator) is unaffected by this check —
    // it keeps working via assertBiddingStillOpen, not this guard.
    if (rescueRequest.quoteCollectionDeadline) return;

    // Move to next batch (same radius; untried operators may still be
    // available), exactly as before.
    void this.startDispatch(rescueRequestId, customerId, extraRadiusKm);
  }

  /**
   * Called after each operator quote/decline.
   *
   * Phase 1 (no deadline yet): if every operator in THIS batch has responded,
   * resolve the batch now instead of waiting out the rest of its window.
   *
   * Phase 2 (deadline set): scope widens to the whole request — batches no
   * longer have independent lives, they all end at the one deadline — and
   * bidding closes as soon as nothing anywhere on the request is pending.
   *
   * That early close is load bearing. The deadline is a CEILING on operators
   * who never answer, never a mandatory wait: three operators answering in
   * the first 40 seconds of a 5-minute collection window must get the
   * motorist a shortlist at 40 seconds, not at 5 minutes.
   */
  private async maybeResolveBatchEarly(rescueRequestId: string, batchId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { customerId: true, quoteCollectionDeadline: true },
    });
    if (!rescueRequest) return;

    if (rescueRequest.quoteCollectionDeadline) {
      const pendingAnywhere = await this.prisma.dispatchOffer.count({
        where: { rescueRequestId, status: 'PENDING' },
      });
      if (pendingAnywhere > 0) return; // stragglers — let the deadline handle them
      await this.closeBidding(rescueRequestId);
      return;
    }

    const batchOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, batchId },
      select: { operatorId: true, status: true },
    });
    const stillPending = batchOffers.some((o) => o.status === 'PENDING');
    if (stillPending) return;

    const batchOperatorIds = batchOffers.map((o) => o.operatorId);
    // extraRadiusKm isn't tracked per-batch outside the session; 0 is correct
    // here because an early-resolved batch (all responded) never needed a
    // radius expansion to find candidates — expansion only happens when
    // zero candidates exist at all, a separate path in startDispatch.
    void this.resolveBatch(rescueRequestId, batchOperatorIds, rescueRequest.customerId, 0, batchId);
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
   * radius, rather than waiting on the automatic no-candidates continuation
   * inside startDispatch. extraRadiusKm isn't persisted between rounds (see
   * the comment on maybeResolveBatchEarly's callers), so the current radius
   * is approximated from the session's dispatchRound — the same
   * approximation the automatic continuation path already effectively
   * produces.
   */
  /**
   * Admin-path guard. `RescueRequest.status` stays DISPATCHING after the
   * shortlist is sent — only the WhatsApp session moves to
   * WAITING_FOR_QUOTE_SELECTION — so the status check alone would happily let
   * an admin offer a job whose bidding is already over.
   *
   * "Closed" is BOTH ways bidding can end, not just the deadline passing: an
   * early close (every offer answered before the deadline) sends the same
   * shortlist, and afterwards the persisted deadline still reads "in future".
   * Guarding on the deadline alone would let an Expand in that gap create a
   * fresh PENDING offer with a future expiresAt, for a job the motorist has
   * already been shown quotes for.
   */
  private assertBiddingStillOpen(
    rescueRequestId: string,
    quoteCollectionDeadline: Date | null | undefined,
  ): void {
    const deadlinePassed = !!quoteCollectionDeadline && Date.now() >= quoteCollectionDeadline.getTime();
    if (deadlinePassed || this.closedRequests.has(rescueRequestId)) {
      throw new BadRequestException('Bidding has closed for this request');
    }
  }

  async expandRadiusNow(rescueRequestId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest || rescueRequest.status !== RescueRequestStatus.DISPATCHING) {
      throw new BadRequestException('Request is not currently DISPATCHING');
    }
    this.assertBiddingStillOpen(rescueRequestId, rescueRequest.quoteCollectionDeadline);

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
    this.assertBiddingStillOpen(rescueRequestId, rescueRequest.quoteCollectionDeadline);

    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator || operator.status !== 'ACTIVE') {
      throw new BadRequestException('Target is not an active operator');
    }

    // As with expandRadiusNow: existing offers are left alone. This adds one
    // more operator to the request, it does not replace the current round.
    // Deadline re-read immediately before the create, not taken from the
    // rescueRequest read at the top of this method: a first quote can land in
    // between and this offer must still be clamped.
    const MANUAL_OFFER_WINDOW_MS = 5 * 60 * 1000;
    const expiresAt = await this.offerExpiryClampedToDeadline(rescueRequestId, MANUAL_OFFER_WINDOW_MS);
    const batchId = crypto.randomUUID();

    // Re-check right before the write, not just at the top of the method:
    // offerExpiryClampedToDeadline only re-reads the deadline, it does not
    // know about an early close (every offer answered, closeBidding fires,
    // this request added to closedRequests) that can happen during the
    // operator lookup / deadline re-read above. Without this, a stray
    // PENDING offer gets created for a job whose shortlist was already sent.
    if (this.closedRequests.has(rescueRequestId)) {
      throw new BadRequestException('Bidding has closed for this request');
    }

    await this.prisma.dispatchOffer.create({
      data: { rescueRequestId, operatorId, expiresAt, batchId },
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
        window: this.formatRemaining(expiresAt), // true remaining time, clamped or not
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
      () => void this.resolveBatch(rescueRequestId, [operatorId], rescueRequest.customerId, currentRadius, batchId),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    this.batchTimers.set(this.batchKey(rescueRequestId, batchId), timer);
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
      quoteCollectionDeadline: r.quoteCollectionDeadline ?? undefined,
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
