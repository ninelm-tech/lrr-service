import { AuditLogService } from '../../src/audit-log/audit-log.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { truncateAll } from './factories';

/**
 * The one property only a real database can show: a write actually lands
 * as a durable row, readable back afterwards — the whole point of this
 * table over an alert that ages out of Sentry.
 */
describe('AuditLogService (integration)', () => {
  let prisma: PrismaService;
  let service: AuditLogService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    service = new AuditLogService(prisma);
  });

  it('writes a durable row with the category, message, details, and actor', async () => {
    await service.record({
      category: 'platform_settings_updated',
      message: 'Updated platform settings',
      details: { serviceFeePercent: 12 },
      actorId: 'admin-1',
    });

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'platform_settings_updated',
      message: 'Updated platform settings',
      details: { serviceFeePercent: 12 },
      actorId: 'admin-1',
      reviewedAt: null,
    });
  });

  it('writes a null actor for a system-detected anomaly', async () => {
    await service.record({
      category: 'unrecognized_transfer_webhook',
      message: 'Unrecognized transfer webhook',
    });

    const row = await prisma.auditLog.findFirstOrThrow();
    expect(row.actorId).toBeNull();
    expect(row.details).toBeNull();
  });

  it('does not throw when the write itself is invalid — logging must never break the caller', async () => {
    // category/message are required at the schema level; passing a
    // non-serializable circular value through `details` is the practical
    // way to force a write failure without mocking Prisma.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      service.record({
        category: 'x',
        message: 'y',
        details: circular as never,
      }),
    ).resolves.toBeUndefined();

    expect(await prisma.auditLog.count()).toBe(0);
  });

  describe('review', () => {
    it('sets reviewedAt and reviewedBy, leaving everything else untouched', async () => {
      await service.record({
        category: 'payout_retried',
        message: 'Retried payout pay-1',
        actorId: 'admin-1',
      });
      const before = await prisma.auditLog.findFirstOrThrow();

      const after = await service.review(before.id, 'admin-2');

      expect(after.reviewedAt).not.toBeNull();
      expect(after.reviewedBy).toBe('admin-2');
      // Reviewing is bookkeeping only — the original actor and category
      // are untouched, unlike the reconciliation feature this replaced.
      expect(after.actorId).toBe('admin-1');
      expect(after.category).toBe('payout_retried');
    });
  });
});
