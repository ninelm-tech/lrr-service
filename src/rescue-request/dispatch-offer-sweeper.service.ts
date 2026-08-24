import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
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

      // Only log when something was actually swept — a quiet system should
      // not write a line every minute.
      if (count > 0) {
        logger.info('dispatch: swept expired offers', { count });
      }
      return count;
    } catch (error) {
      console.error('Failed to sweep expired dispatch offers:', error);
      Sentry.captureException(error);
      return 0;
    }
  }
}
