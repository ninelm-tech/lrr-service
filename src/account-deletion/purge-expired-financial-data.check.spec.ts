import { Test, TestingModule } from '@nestjs/testing';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { createAuditLogServiceMock } from '../audit-log/testing/audit-log.mock';

describe('PurgeExpiredFinancialDataCheck', () => {
  let check: PurgeExpiredFinancialDataCheck;
  let prisma: { payment: { deleteMany: jest.Mock } };
  let auditLogService: ReturnType<typeof createAuditLogServiceMock>;

  beforeEach(async () => {
    prisma = { payment: { deleteMany: jest.fn() } };
    auditLogService = createAuditLogServiceMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurgeExpiredFinancialDataCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();
    check = module.get(PurgeExpiredFinancialDataCheck);
  });

  it('is a no-op and writes no audit entry when nothing qualifies', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 0 });

    const result = await check.run(new Date('2031-01-01'));

    expect(result).toBe(0);
    expect(auditLogService.record).not.toHaveBeenCalled();
  });

  it('scopes the OR clause: PAYOUT gated on operator.deletedAt, everything else on customer.deletedAt', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date('2031-01-01T00:00:00Z');

    await check.run(now);

    const cutoff = new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    expect(prisma.payment.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          {
            type: { in: ['DEPOSIT', 'BALANCE', 'REFUND'] },
            rescueRequest: { customer: { deletedAt: { not: null } } },
          },
          { type: 'PAYOUT', operator: { deletedAt: { not: null } } },
        ],
      },
    });
  });

  it('writes an audit entry with the purged count when rows were deleted', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 3 });

    await check.run(new Date('2031-01-01'));

    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'financial_data_purged',
        message: 'Purged 3 Payment rows past retention window',
      }),
    );
  });
});
