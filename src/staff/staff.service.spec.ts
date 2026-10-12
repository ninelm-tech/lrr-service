import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StaffService } from './staff.service';

// Typed once so the matcher does not surface as an `any` assignment.
const anySelect = expect.any(Object) as object;

describe('StaffService', () => {
  let service: StaffService;
  let prisma: {
    user: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [StaffService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(StaffService);
  });

  describe('list', () => {
    it('only ever returns internal roles, never customers or operators', async () => {
      await service.list({ page: 1, limit: 25 });

      const where = (
        prisma.user.findMany.mock.calls[0] as [{ where: Record<string, any> }]
      )[0].where;
      expect(where.role).toEqual({ in: ['ADMIN', 'SUPER_ADMIN', 'PRODUCT'] });
      expect(where.deletedAt).toBeNull();
    });

    it('applies search across name, email and paginates', async () => {
      prisma.user.count.mockResolvedValue(30);

      const result = await service.list({ page: 2, limit: 10, search: 'ada' });

      const args = (
        prisma.user.findMany.mock.calls[0] as [
          { where: Record<string, any>; skip: number; take: number },
        ]
      )[0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      expect(args.where.OR).toEqual([
        { name: { contains: 'ada', mode: 'insensitive' } },
        { email: { contains: 'ada', mode: 'insensitive' } },
      ]);
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 30, pages: 3 });
    });

    it('never selects the password hash', async () => {
      await service.list({ page: 1, limit: 25 });
      const select = (
        prisma.user.findMany.mock.calls[0] as [{ select: Record<string, true> }]
      )[0].select;
      expect(select.passwordHash).toBeUndefined();
    });
  });

  describe('update', () => {
    const target = {
      id: 'staff-1',
      role: 'PRODUCT',
      name: 'Old Name',
      deletedAt: null,
    };

    it('refuses to edit your own account', async () => {
      await expect(
        service.update('me', { role: 'ADMIN' }, 'me'),
      ).rejects.toThrow('your own account');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses an empty change', async () => {
      await expect(service.update('staff-1', {}, 'me')).rejects.toThrow(
        'Nothing to update',
      );
    });

    it.each(['SUPER_ADMIN', 'CUSTOMER', 'OPERATOR', 'nonsense'])(
      'rejects assigning role %s',
      async (role) => {
        prisma.user.findUnique.mockResolvedValue(target);
        await expect(
          service.update('staff-1', { role: role as never }, 'me'),
        ).rejects.toThrow('role must be ADMIN or PRODUCT');
        expect(prisma.user.update).not.toHaveBeenCalled();
      },
    );

    it('rejects a blank name', async () => {
      prisma.user.findUnique.mockResolvedValue(target);
      await expect(
        service.update('staff-1', { name: '   ' }, 'me'),
      ).rejects.toThrow('name');
    });

    it('404s for a missing or deleted user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.update('staff-1', { name: 'X' }, 'me'),
      ).rejects.toThrow('Staff member not found');

      prisma.user.findUnique.mockResolvedValue({
        ...target,
        deletedAt: new Date(),
      });
      await expect(
        service.update('staff-1', { name: 'X' }, 'me'),
      ).rejects.toThrow('Staff member not found');
    });

    it.each(['SUPER_ADMIN', 'CUSTOMER', 'OPERATOR'])(
      'cannot edit a %s through the staff endpoint',
      async (role) => {
        prisma.user.findUnique.mockResolvedValue({ ...target, role });
        await expect(
          service.update('staff-1', { name: 'X' }, 'me'),
        ).rejects.toThrow('Staff member not found');
        expect(prisma.user.update).not.toHaveBeenCalled();
      },
    );

    it('updates role and trimmed name, returning before/after of the changed fields', async () => {
      prisma.user.findUnique.mockResolvedValue(target);
      prisma.user.update.mockResolvedValue({
        id: 'staff-1',
        role: 'ADMIN',
        name: 'New Name',
      });

      const result = await service.update(
        'staff-1',
        { role: 'ADMIN', name: '  New Name ' },
        'me',
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        data: { role: 'ADMIN', name: 'New Name' },
        select: anySelect,
      });
      expect(result.before).toEqual({ role: 'PRODUCT', name: 'Old Name' });
      expect(result.after).toEqual({ role: 'ADMIN', name: 'New Name' });
    });
  });
});
