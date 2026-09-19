import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';

@Injectable()
export class AccountDeletionTickerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly INTERVAL_MS = 60 * 60 * 1000;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly purgeCheck: PurgeExpiredFinancialDataCheck,
    private readonly mediaRetryCheck: RetryMediaDeletionCheck,
  ) {}

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(now: Date = new Date()): Promise<void> {
    for (const check of [this.purgeCheck, this.mediaRetryCheck]) {
      try {
        await check.run(now);
      } catch (error) {
        console.error(`Account-deletion check "${check.name}" failed:`, error);
        Sentry.captureException(error, { extra: { check: check.name } });
      }
    }
  }
}
