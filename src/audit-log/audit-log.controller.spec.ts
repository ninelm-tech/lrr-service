import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { createAuditLogServiceMock } from './testing/audit-log.mock';

const req = { user: { userId: 'admin-1' } } as never;

describe('AuditLogController', () => {
  let controller: AuditLogController;
  let prisma: {
    auditLog: { findMany: jest.Mock; count: jest.Mock };
  };
  let auditLogService: ReturnType<typeof createAuditLogServiceMock>;

  beforeEach(async () => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    auditLogService = createAuditLogServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditLogController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get<AuditLogController>(AuditLogController);
  });

  describe('list', () => {
    it('orders newest first, and reports total/page/limit in meta', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
      prisma.auditLog.count.mockResolvedValue(1);

      const result = await controller.list(undefined, undefined, undefined);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(result).toEqual({
        data: [{ id: 'log-1' }],
        meta: { total: 1, page: 1, limit: 25 },
      });
    });

    it('filters by category when given', async () => {
      await controller.list('staff_created', undefined, undefined);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { category: 'staff_created' } }),
      );
      expect(prisma.auditLog.count).toHaveBeenCalledWith({
        where: { category: 'staff_created' },
      });
    });

    it('paginates using page and limit', async () => {
      await controller.list(undefined, '3', '10');

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('clamps an oversized limit to 100, so a page can never scan the whole table', async () => {
      await controller.list(undefined, '1', '5000');

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('treats a zero or negative page as page 1', async () => {
      await controller.list(undefined, '0', '25');

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0 }),
      );
    });
  });

  describe('review', () => {
    it('delegates to AuditLogService.review with the acting admin', async () => {
      await controller.review(req, 'log-1');

      expect(auditLogService.review).toHaveBeenCalledWith('log-1', 'admin-1');
    });

    it('returns the updated entry', async () => {
      const result = await controller.review(req, 'log-1');

      expect(result.message).toBe('Marked reviewed');
      expect(result.data).toMatchObject({ id: 'log-1', reviewedBy: 'admin-1' });
    });
  });
});
