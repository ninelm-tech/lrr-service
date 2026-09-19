import { Injectable } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Closes dispatch offers that can no longer be answered: those past their
 * own expiry, and those on a request that has already ended.
 *
 * A dispatch offer used to be closed out only by DispatchService.resolveBatch,
 * from an in-memory setTimeout — so every deploy or restart stranded whatever
 * was in flight, and those orphans surfaced later as the "you have N jobs
 * open at once" prompt listing jobs that had ended days ago. Expiry is a
 * property of the row, not of a live process, so this cannot recur.
 *
 * CRITICAL — this check must NOT touch expired offers on a request that is
 * still DISPATCHING. Those belong to BatchResolveCheck, which needs to see
 * them to decide whether to shortlist or start the next round. Sweeping
 * them here would consume the batch first and dispatch would silently stop
 * progressing: batch resolve would find nothing to resolve, every round,
 * forever. Ownership is expressed in the predicate below, not in run order,
 * so re-ordering the checks cannot reintroduce it.
 */
@Injectable()
export class OfferSweepCheck implements ReconcilerCheck {
  readonly name = 'offer-sweep';
  private readonly MAX_PER_PASS = 500;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One query, because both sweeps share the same exclusion. Prisma's
   * updateMany takes scalar filters only, so the relation conditions live
   * in a findMany and the write is by id. Bounded per pass; a backlog
   * drains over successive ticks rather than in one huge write.
   */
  async run(now: Date): Promise<number> {
    const sweepable = await this.prisma.dispatchOffer.findMany({
      where: {
        status: 'PENDING',
        // Batch resolve owns anything on a live dispatch.
        rescueRequest: { status: { not: RescueRequestStatus.DISPATCHING } },
        OR: [
          { expiresAt: { lt: now } },
          {
            rescueRequest: {
              status: {
                in: [
                  RescueRequestStatus.COMPLETED,
                  RescueRequestStatus.CANCELLED,
                ],
              },
            },
          },
        ],
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });
    if (sweepable.length === 0) return 0;

    const { count } = await this.prisma.dispatchOffer.updateMany({
      where: { id: { in: sweepable.map((o) => o.id) }, status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: now },
    });
    return count;
  }
}
