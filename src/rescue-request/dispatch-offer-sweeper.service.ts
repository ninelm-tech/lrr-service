import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Marks expired PENDING dispatch offers as TIMED_OUT.
 *
 * A dispatch offer is normally closed out by DispatchService.resolveBatch,
 * which only ever runs from an in-memory setTimeout. Every deploy, restart,
 * or ECS task recycle destroys those timers, so any offer in flight at that
 * moment stays PENDING forever — nothing else in the service ever touches
 * it. Those orphans accumulate per operator and then surface as the
 * "you have N jobs open at once" disambiguation prompt on the operator's
 * next unrelated quote, listing jobs that ended days ago.
 *
 * This sweeper is the durable backstop: expiry is a property of the row
 * (expiresAt), not of a live process, so a restart can no longer strand
 * anything. The first run after boot doubles as the backfill for offers
 * already orphaned.
 *
 * Idempotent by construction — the update is conditioned on
 * (status = PENDING AND expiresAt < now), so running it concurrently on
 * several instances is harmless.
 */
@Injectable()
export class DispatchOfferSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly SWEEP_INTERVAL_MS = 60 * 1000;
  private readonly MAX_ORPHANS_PER_SWEEP = 500;
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Sweep once at boot so orphans left by the restart that just happened
    // are cleared immediately rather than one interval later.
    void this.sweep();

    this.timer = setInterval(() => void this.sweep(), this.SWEEP_INTERVAL_MS);
    // Don't hold the event loop open — matters for tests and clean shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<number> {
    try {
      const { count } = await this.prisma.dispatchOffer.updateMany({
        where: { status: 'PENDING', expiresAt: { lt: new Date() } },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });

      const orphaned = await this.sweepOffersOnEndedRequests();
      const total = count + orphaned;

      // Only log when something was actually swept — a quiet system should
      // not write a line every minute.
      if (total > 0) {
        logger.info('dispatch: swept offers', { expired: count, onEndedRequests: orphaned });
      }
      return total;
    } catch (error) {
      console.error('Failed to sweep expired dispatch offers:', error);
      Sentry.captureException(error);
      return 0;
    }
  }

  /**
   * Closes offers still PENDING on a request that has already ended.
   *
   * The expiry sweep above cannot see these: the request is dead but the
   * offer's own expiresAt is still in the future, so the operator keeps
   * counting it as an open job. Each path to a terminal status now releases
   * its own offers directly; this is the durable backstop for when the
   * process dies mid-cancel, for a terminal path added later and not wired
   * up, and as the one-off backfill for offers already orphaned.
   *
   * Two steps because Prisma's updateMany takes scalar filters only — the
   * relation filter this needs is available on findMany. Bounded per pass;
   * a backlog drains over successive sweeps rather than in one huge write.
   */
  private async sweepOffersOnEndedRequests(): Promise<number> {
    const orphans = await this.prisma.dispatchOffer.findMany({
      where: {
        status: 'PENDING',
        rescueRequest: {
          status: { in: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] },
        },
      },
      select: { id: true },
      take: this.MAX_ORPHANS_PER_SWEEP,
    });
    if (orphans.length === 0) return 0;

    const { count } = await this.prisma.dispatchOffer.updateMany({
      where: { id: { in: orphans.map((o) => o.id) } },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });
    return count;
  }
}
