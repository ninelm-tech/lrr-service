import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import {
  RECONCILER_CHECKS,
  ReconcilerCheck,
} from './reconciler-check.interface';

@Injectable()
export class ReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly INTERVAL_MS = 15 * 1000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(RECONCILER_CHECKS) private readonly checks: ReconcilerCheck[],
  ) {}

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One pass over every check.
   *
   * Never rejects: a check that throws is reported and the rest still run,
   * because one failing query must not stop unrelated work. Overlapping
   * ticks are skipped rather than queued — a database slow enough to
   * outlast the interval would otherwise accumulate concurrent passes.
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const check of this.checks) {
        try {
          const acted = await check.run(now);
          if (acted > 0)
            logger.info('reconciler: acted', {
              check: check.name,
              count: acted,
            });
        } catch (error) {
          console.error(`Reconciler check "${check.name}" failed:`, error);
          Sentry.captureException(error, {
            extra: { reconcilerCheck: check.name },
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
