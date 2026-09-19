import { Test, TestingModule } from '@nestjs/testing';
import { OperatorMembershipService } from './operator-membership.service';
import { PrismaService } from '../prisma/prisma.service';

describe('OperatorMembershipService', () => {
  let service: OperatorMembershipService;
  let prisma: {
    operatorMember: { findMany: jest.Mock; findFirst: jest.Mock };
    user: { updateMany: jest.Mock };
    operator: { updateMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      operatorMember: { findMany: jest.fn(), findFirst: jest.fn() },
      user: { updateMany: jest.fn() },
      operator: { updateMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorMembershipService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(OperatorMembershipService);
  });

  describe('findActiveOperatorIdsForUser', () => {
    it('excludes a deleted operator via the relation filter', async () => {
      prisma.operatorMember.findMany.mockResolvedValue([
        { operatorId: 'op-1' },
      ]);

      const result = await service.findActiveOperatorIdsForUser('user-1');

      expect(prisma.operatorMember.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          operator: { deletedAt: null },
          user: { deletedAt: null },
        },
        select: { operatorId: true },
      });
      expect(result).toEqual(['op-1']);
    });
  });

  describe('assertActiveMembership', () => {
    it('throws when no membership matches (operator or user deleted, or not a member)', async () => {
      prisma.operatorMember.findFirst.mockResolvedValue(null);

      await expect(
        service.assertActiveMembership('user-1', 'op-1'),
      ).rejects.toThrow(
        'Not a member of this operator, the operator has been deleted, or this account has been deleted.',
      );
    });

    it('resolves when an active membership matches', async () => {
      prisma.operatorMember.findFirst.mockResolvedValue({ id: 'mem-1' });

      await expect(
        service.assertActiveMembership('user-1', 'op-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('lockActiveMembership', () => {
    const tx = {
      operatorMember: { findFirst: jest.fn() },
      user: { updateMany: jest.fn() },
      operator: { updateMany: jest.fn() },
    } as never;
    const operatorStaff = { userId: 'user-1', role: 'OPERATOR' };
    const admin = { userId: 'admin-1', role: 'SUPER_ADMIN' };

    // `tx`'s mocks are shared across every test in this block — clear call
    // history (not just return values) between tests, or an earlier test's
    // call count leaks into a later `not.toHaveBeenCalled()` assertion.
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('throws when the acting user has been deleted, before ever reading membership', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('This account has been deleted.');

      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws when the acting admin has been deleted', async () => {
      const t = tx as { user: { updateMany: jest.Mock } };
      t.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, admin, 'op-1'),
      ).rejects.toThrow('This account has been deleted.');
    });

    it('locks the user, then throws when the operator has been deleted, before ever reading membership', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('This operator has been deleted.');

      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws when both locks succeed but no membership row exists (non-admin)', async () => {
      // This is the regression that matters most for this method: an
      // earlier draft read membership FIRST, unlocked — a plain read
      // racy against a concurrent removeMember on the same operator.
      // Both row locks must be acquired before this read is trusted.
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });
      t.operatorMember.findFirst.mockResolvedValue(null);

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('Not a member of this operator.');
    });

    it('skips the membership-row check entirely for an ADMIN/SUPER_ADMIN, once both locks succeed', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.lockActiveMembership(tx, admin, 'op-1'),
      ).resolves.toBeUndefined();
      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('resolves when membership, user, and operator are all active', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.operatorMember.findFirst.mockResolvedValue({ id: 'mem-1' });
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).resolves.toBeUndefined();
    });
  });
});
