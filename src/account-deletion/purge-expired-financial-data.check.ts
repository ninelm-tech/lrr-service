import { Injectable } from '@nestjs/common';
import { PaymentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class PurgeExpiredFinancialDataCheck {
  readonly name = 'purge-expired-financial-data';
  private readonly RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async run(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.RETENTION_MS);
    const result = await this.prisma.payment.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          {
            type: {
              in: [
                PaymentType.DEPOSIT,
                PaymentType.BALANCE,
                PaymentType.REFUND,
              ],
            },
            rescueRequest: { customer: { deletedAt: { not: null } } },
          },
          { type: PaymentType.PAYOUT, operator: { deletedAt: { not: null } } },
        ],
      },
    });
    if (result.count > 0) {
      await this.auditLogService.record({
        category: 'financial_data_purged',
        message: `Purged ${result.count} Payment rows past retention window`,
        details: { cutoff: cutoff.toISOString() },
      });
    }
    return result.count;
  }
}
