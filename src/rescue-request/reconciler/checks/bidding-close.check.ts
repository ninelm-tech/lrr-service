import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { logger } from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DispatchService } from '../../dispatch.service';
import { QUOTE_SELECTION_WINDOW_MS } from '../../dispatch.constants';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Phase 2 owns progression: once quoteCollectionDeadline is set, only this
 * check may send the shortlist. Stamping biddingClosedAt is the claim, so a
 * request can be progressed past bidding exactly once even if another
 * caller is added later.
 */
@Injectable()
export class BiddingCloseCheck implements ReconcilerCheck {
  readonly name = 'bidding-close';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.DISPATCHING,
        quoteCollectionDeadline: { lt: now },
        biddingClosedAt: null,
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.close(id, now)) acted += 1;
    }
    return acted;
  }

  /**
   * The claim, closing the request's offers, AND opening the selection
   * window all commit together.
   *
   * The selection deadline is the subtle one. Stamping biddingClosedAt and
   * then setting quoteSelectionExpiresAt inside the message-sending method
   * would, on a crash between the two, leave a request that bidding-close
   * can never match again (biddingClosedAt is set) and that
   * quote-selection-timeout can never match either (its deadline is null).
   * The request would sit in DISPATCHING forever — the same permanent
   * stranding this whole design exists to remove, arrived at through the
   * one transition that hands off between two checks.
   *
   * Only the message goes out after the commit.
   */
  private async close(rescueRequestId: string, now: Date): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteCollectionDeadline: { lt: now },
          biddingClosedAt: null,
        },
        data: {
          biddingClosedAt: now,
          // Hands the request to QuoteSelectionTimeoutCheck atomically.
          quoteSelectionExpiresAt: new Date(
            now.getTime() + QUOTE_SELECTION_WINDOW_MS,
          ),
        },
      });
      if (count === 0) return null; // another tick or instance claimed it

      await tx.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { customerId: true },
      });
      return { customerId: request.customerId };
    });

    if (!outcome) return false;

    logger.info('dispatch: bidding closed', { rescueRequestId });
    await this.dispatchService.deliverQuoteShortlist(
      rescueRequestId,
      outcome.customerId,
    );
    return true;
  }
}
