import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock } };

  beforeEach(async () => {
    (Sentry.captureException as jest.Mock).mockClear();
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
  });

  it('writes the category, message, details, and actor', async () => {
    await service.record({
      category: 'staff_created',
      message: 'Created staff account for ada@example.com',
      details: { newUserId: 'user-1', role: 'ADMIN' },
      actorId: 'admin-1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        category: 'staff_created',
        message: 'Created staff account for ada@example.com',
        details: { newUserId: 'user-1', role: 'ADMIN' },
        actorId: 'admin-1',
      },
    });
  });

  it('writes null for actorId when none is given — a system-detected anomaly, not a human action', async () => {
    await service.record({
      category: 'unrecognized_transfer_webhook',
      message: 'Unrecognized transfer webhook',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        category: 'unrecognized_transfer_webhook',
        message: 'Unrecognized transfer webhook',
        details: undefined,
        actorId: null,
      },
    });
  });

  it('never throws when the write fails — logging must not break the action being audited', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('DB unavailable'));

    await expect(
      service.record({ category: 'x', message: 'y' }),
    ).resolves.toBeUndefined();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { category: 'x', message: 'y' } }),
    );
  });
});
