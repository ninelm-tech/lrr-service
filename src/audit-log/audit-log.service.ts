import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { AuditLog } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecordAuditLogInput } from './dto/record-audit-log-input.dto';

/**
 * A durable record of security-sensitive, financial, or otherwise
 * consequential actions, alongside whatever alert (Sentry, a notification)
 * already exists for the moment it happened. Sentry ages out and isn't
 * something everyone checks; this is the permanent, queryable one.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writing the audit entry must never break the action being audited —
   * callers call this after their own action has already succeeded (or,
   * for a system-detected anomaly, whenever they detect it), and a failure
   * here should be visible in Sentry but never bubble up and fail the
   * response the caller is about to send.
   */
  async record(input: RecordAuditLogInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          category: input.category,
          message: input.message,
          details: input.details,
          actorId: input.actorId ?? null,
        },
      });
    } catch (err) {
      console.error('Failed to write audit log entry:', err);
      Sentry.captureException(err, {
        extra: { category: input.category, message: input.message },
      });
    }
  }

  /**
   * Marks an entry as looked at. Bookkeeping only — unlike the
   * reconciliation feature this replaced, reviewing an entry never
   * changes anything else in the system, it only records that a human
   * saw it.
   */
  async review(id: string, reviewedBy: string): Promise<AuditLog> {
    return this.prisma.auditLog.update({
      where: { id },
      data: { reviewedAt: new Date(), reviewedBy },
    });
  }
}
