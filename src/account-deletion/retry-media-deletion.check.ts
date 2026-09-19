import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

@Injectable()
export class RetryMediaDeletionCheck {
  readonly name = 'retry-media-deletion';

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * `_now` is unused — this check has no notion of a retention clock —
   * but the parameter must exist so this class's `run` has the same call
   * signature as `PurgeExpiredFinancialDataCheck.run(now: Date)`. Without
   * it, `AccountDeletionTickerService.tick()`'s loop calling `check.run(now)`
   * against a union of both check types fails to compile: TypeScript's
   * excess-argument checking rejects passing an argument to a function
   * declared with zero parameters, even though extra arguments are
   * harmless at runtime.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above
  async run(_now?: Date): Promise<number> {
    const pending = await this.prisma.pendingMediaDeletion.findMany({
      take: 100,
    });
    let cleared = 0;
    for (const row of pending) {
      try {
        await this.s3Service.deleteObject(row.s3Key);
        await this.prisma.pendingMediaDeletion.delete({
          where: { id: row.id },
        });
        cleared++;
      } catch (err) {
        console.error(
          `Retry: failed to delete media object ${row.s3Key}:`,
          err,
        );
        Sentry.captureException(err, { extra: { s3Key: row.s3Key } });
      }
    }
    return cleared;
  }
}
