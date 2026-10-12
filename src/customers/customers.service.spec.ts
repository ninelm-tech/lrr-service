import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from './customers.service';

// Typed once so the matcher does not surface as an `any` assignment.
const anySelect = expect.any(Object) as object;

describe('CustomersService', () => {
  let service: CustomersService;
  let prisma: {
    user: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
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
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  describe('list', () => {
    it('only returns CUSTOMER-role users, with deletedAt so the UI can badge deleted ones', async () => {
      await service.list({ page: 1, limit: 25 });
      const args = (
        prisma.user.findMany.mock.calls[0] as [
          { where: Record<string, any>; select: Record<string, true> },
        ]
      )[0];
      expect(args.where.role).toBe('CUSTOMER');
      expect(args.select.deletedAt).toBe(true);
      expect(args.select.passwordHash).toBeUndefined();
    });

    it('searches name, email and phone', async () => {
      await service.list({ page: 1, limit: 25, search: '0803' });
      const where = (
        prisma.user.findMany.mock.calls[0] as [{ where: Record<string, any> }]
      )[0].where;
      expect(where.OR).toEqual([
        { name: { contains: '0803', mode: 'insensitive' } },
        { email: { contains: '0803', mode: 'insensitive' } },
        { phoneNumber: { contains: '0803' } },
      ]);
    });
  });

  describe('update', () => {
    const customer = {
      id: 'c-1',
      role: 'CUSTOMER',
      name: 'Old',
      email: 'old@example.com',
      deletedAt: null,
    };

    it('rejects an empty change', async () => {
      await expect(service.update('c-1', {})).rejects.toThrow(
        'Nothing to update',
      );
    });

    it('404s for non-customers and deleted customers', async () => {
      for (const row of [
        null,
        { ...customer, role: 'OPERATOR' },
        { ...customer, role: 'ADMIN' },
        { ...customer, deletedAt: new Date() },
      ]) {
        prisma.user.findUnique.mockResolvedValue(row);
        await expect(service.update('c-1', { name: 'X' })).rejects.toThrow(
          'Customer not found',
        );
      }
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('does not accept a phone number change — phone is the login identity', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      await expect(
        service.update('c-1', { phoneNumber: '+2348000000000' } as never),
      ).rejects.toThrow('Nothing to update');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed email', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      await expect(
        service.update('c-1', { email: 'not-an-email' }),
      ).rejects.toThrow('valid email');
    });

    it('rejects an email already used by another account', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      prisma.user.findFirst.mockResolvedValue({ id: 'other' });
      await expect(
        service.update('c-1', { email: 'taken@example.com' }),
      ).rejects.toThrow('already in use');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('turns a unique-constraint race (P2002) into a 409, not a 500', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.update('c-1', { email: 'race@example.com' }),
      ).rejects.toThrow('already in use');
    });

    it('rethrows unrelated database errors untouched', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      prisma.user.update.mockRejectedValue(new Error('db down'));

      await expect(service.update('c-1', { name: 'X' })).rejects.toThrow(
        'db down',
      );
    });

    it('lowercases/trims email and trims name, returning the changed field names only', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      prisma.user.update.mockResolvedValue({ id: 'c-1' });

      const result = await service.update('c-1', {
        name: ' New Name ',
        email: ' New@Example.COM ',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'c-1' },
        data: { name: 'New Name', email: 'new@example.com' },
        select: anySelect,
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          email: { equals: 'new@example.com', mode: 'insensitive' },
          id: { not: 'c-1' },
        },
        select: { id: true },
      });
      expect(result.changedFields).toEqual(['name', 'email']);
    });

    it('allows clearing email with null', async () => {
      prisma.user.findUnique.mockResolvedValue(customer);
      prisma.user.update.mockResolvedValue({ id: 'c-1' });
      await service.update('c-1', { email: null });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { email: null } }),
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
  });
});
