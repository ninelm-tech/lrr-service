import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DispatchService } from '../../dispatch.service';
import { QUOTE_SELECTION_WINDOW_MS } from '../../dispatch.constants';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Resolves a dispatch batch whose offers have expired: closes them, and
 * either shortlists the quotes that came in or starts the next round.
 *
 * Replaces the per-batch setTimeout that a restart destroyed, leaving the
 * request in DISPATCHING with nothing left to fire.
 */
@Injectable()
export class BatchResolveCheck implements ReconcilerCheck {
  readonly name = 'batch-resolve';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
  ) {}

  async run(now: Date): Promise<number> {
    const expiredOffers = await this.prisma.dispatchOffer.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
        rescueRequest: { status: RescueRequestStatus.DISPATCHING },
      },
      select: {
        id: true,
        rescueRequestId: true,
        batchId: true,
        dispatchRound: true,
      },
      take: this.MAX_PER_PASS,
    });

    const batches = new Map<
      string,
      { rescueRequestId: string; round: number; offerIds: string[] }
    >();
    for (const offer of expiredOffers) {
      const key = `${offer.rescueRequestId}:${offer.batchId}`;
      const entry = batches.get(key) ?? {
        rescueRequestId: offer.rescueRequestId,
        round: offer.dispatchRound,
        offerIds: [],
      };
      entry.offerIds.push(offer.id);
      batches.set(key, entry);
    }

    let acted = 0;
    for (const batch of batches.values()) {
      if (await this.resolve(batch, now)) acted += 1;
    }
    return acted;
  }

  /**
   * Expiring the batch, claiming progression, AND creating the next round's
   * offers all commit together.
   *
   * Advancing the round and only then creating offers would, on a crash
   * between the two, leave the request on round N+1 with no offers for it —
   * and nothing can retry, because the CAS requires dispatchRound to equal
   * the batch's round, which is now behind. The request would sit in
   * DISPATCHING forever with no live offers and no check able to match it.
   *
   * Only the WhatsApp sends happen after the commit.
   */
  private async resolve(
    batch: { rescueRequestId: string; round: number; offerIds: string[] },
    now: Date,
  ): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.dispatchOffer.updateMany({
        where: { id: { in: batch.offerIds }, status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      // Progression is claimed, never merely read. quoteCollectionDeadline
      // must still be null AT THIS MOMENT (a first quote may have landed
      // since we queried), and the round must be THIS batch's — otherwise a
      // straggler from an earlier round would advance dispatch on behalf of
      // a round that already finished.
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: batch.rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteCollectionDeadline: null,
          dispatchRound: batch.round,
        },
        data: { dispatchRound: batch.round + 1 },
      });
      if (count === 0) return null;

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: batch.rescueRequestId },
        select: { customerId: true },
      });

      const quoted = await tx.dispatchOffer.count({
        where: { rescueRequestId: batch.rescueRequestId, status: 'QUOTED' },
      });
      if (quoted > 0) {
        // Close EVERY remaining PENDING offer on the request, not just this
        // batch's. Another batch — or an admin's manual offer — can still be
        // live, and an operator answering one after the motorist already has
        // a shortlist would quote into a closed auction.
        await tx.dispatchOffer.updateMany({
          where: { rescueRequestId: batch.rescueRequestId, status: 'PENDING' },
          data: { status: 'TIMED_OUT', respondedAt: now },
        });

        // Opening the selection window belongs in THIS transaction, for the
        // same reason as in BiddingCloseCheck: committing the round advance
        // and setting the deadline inside the sending method would, on a
        // crash between them, leave a request no check can match — batch
        // resolve has no expired offers left, and quote-selection-timeout
        // has no deadline.
        //
        // biddingClosedAt is stamped here too. It is the backstop for ANY
        // path that progresses a request past bidding, so a phase-1
        // shortlist must claim it as well — otherwise bidding-close could
        // later match the same request and send a second shortlist.
        await tx.rescueRequest.update({
          where: { id: batch.rescueRequestId },
          data: {
            biddingClosedAt: now,
            quoteSelectionExpiresAt: new Date(
              now.getTime() + QUOTE_SELECTION_WINDOW_MS,
            ),
          },
        });
        return {
          outcome: 'shortlist' as const,
          customerId: request.customerId,
        };
      }

      // No quotes: the next round's offer rows are written HERE, inside the
      // same transaction as the round advance, so the two can never
      // disagree. Only the sends are deferred.
      const next = await this.dispatchService.prepareNextRound(
        tx,
        batch.rescueRequestId,
        batch.round + 1,
      );

      // Exhausted means no operator remains to try. Advancing the round and
      // creating nothing would leave a DISPATCHING request with no live
      // offers — nothing to expire, so batch resolve never sees it again and
      // the motorist waits forever. The cancel must commit with the advance.
      if (next.exhausted) {
        await tx.rescueRequest.update({
          where: { id: batch.rescueRequestId },
          data: {
            status: RescueRequestStatus.CANCELLED,
            dispatchRound: next.round,
          },
        });
        await tx.dispatchOffer.updateMany({
          where: { rescueRequestId: batch.rescueRequestId, status: 'PENDING' },
          data: { status: 'TIMED_OUT', respondedAt: now },
        });
        await tx.whatsAppSession.updateMany({
          where: { userId: request.customerId },
          data: { state: 'IDLE', rescueRequestId: null },
        });
        return {
          outcome: 'exhausted' as const,
          customerId: request.customerId,
          reason: next.reason,
          round: next.round,
        };
      }

      return {
        outcome: 'nextRound' as const,
        customerId: request.customerId,
        offers: next.offers,
      };
    });

    if (!outcome) return true; // offers expired; progression belongs to someone else

    switch (outcome.outcome) {
      case 'shortlist':
        await this.dispatchService.deliverQuoteShortlist(
          batch.rescueRequestId,
          outcome.customerId,
        );
        break;
      case 'nextRound':
        await this.dispatchService.deliverOffers(outcome.offers);
        break;
      case 'exhausted':
        await this.dispatchService.notifyNoOperatorAvailable(
          batch.rescueRequestId,
          outcome.customerId,
          outcome.reason,
          outcome.round,
        );
        break;
    }
    return true;
  }
}
