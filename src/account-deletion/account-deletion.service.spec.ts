import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';
import { AccountDeletionService } from './account-deletion.service';

// Typed once so asymmetric matchers don't surface as `any` assignments.
const anyDate = expect.any(Date) as Date;

describe('AccountDeletionService.deleteUser', () => {
  let service: AccountDeletionService;
  let tx: {
    user: { updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    operator: {
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    rescueRequest: { findMany: jest.Mock; updateMany: jest.Mock };
    operatorMember: { findMany: jest.Mock; count: jest.Mock };
    requestMedia: { findMany: jest.Mock; deleteMany: jest.Mock };
    pendingMediaDeletion: { createMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    pendingMediaDeletion: { delete: jest.Mock };
  };
  let s3Service: { deleteObject: jest.Mock };

  beforeEach(async () => {
    tx = {
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      operator: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      rescueRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      operatorMember: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      requestMedia: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
      },
      pendingMediaDeletion: { createMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    prisma = {
      $transaction: jest
        .fn()
        .mockImplementation(
          (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
        ),
      pendingMediaDeletion: { delete: jest.fn() },
    };
    s3Service = { deleteObject: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3Service },
      ],
    }).compile();
    service = module.get(AccountDeletionService);
  });

  it('locks only parent columns before reading child guards', async () => {
    await service.deleteUser('user-1', 'admin-1');

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-1',
        deletedAt: null,
        role: { in: ['CUSTOMER', 'OPERATOR'] },
      },
      data: { updatedAt: expect.any(Date) },
    });
    expect(tx.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.rescueRequest.findMany.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [null, 'User not found'],
    [{ role: 'CUSTOMER', deletedAt: new Date() }, 'already been deleted'],
    [{ role: 'ADMIN', deletedAt: null }, 'Only customer and operator accounts'],
    [
      { role: 'SUPER_ADMIN', deletedAt: null },
      'Only customer and operator accounts',
    ],
    [
      { role: 'PRODUCT', deletedAt: null },
      'Only customer and operator accounts',
    ],
  ])('explains a failed parent lock for %p', async (user, message) => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue(user);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      message,
    );
    expect(tx.rescueRequest.findMany).not.toHaveBeenCalled();
  });

  it('refuses a user who still belongs to an active operator, pointing at the Operators page', async () => {
    tx.operatorMember.count.mockResolvedValue(1);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'delete the operator from the Operators page',
    );
    expect(tx.operatorMember.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', operator: { deletedAt: null } },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('still deletes an orphan OPERATOR user with no active membership', async () => {
    tx.operatorMember.count.mockResolvedValue(0);

    await service.deleteUser('orphan-1', 'admin-1');

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'orphan-1' } }),
    );
  });

  it('blocks fresh active, disputed, or processing-payment requests', async () => {
    tx.rescueRequest.findMany.mockResolvedValue([
      { id: 'req-1' },
      { id: 'req-2' },
    ]);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'Cannot delete: 2 request(s)',
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    const requestQuery = tx.rescueRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(requestQuery.where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payments: expect.objectContaining({
            some: expect.objectContaining({
              type: { in: ['DEPOSIT', 'BALANCE', 'REFUND'] },
            }),
          }),
        }),
      ]),
    );
  });

  it('blocks an owner of an active operator business', async () => {
    tx.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'owns 1 active operator business',
    );
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('anonymizes identity, scrubs requests, queues customer media, and audits atomically', async () => {
    tx.requestMedia.findMany.mockResolvedValue([
      { id: 'media-1', s3Key: 'key-1' },
    ]);

    await service.deleteUser('user-1', 'admin-1');

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: expect.objectContaining({
        name: 'Deleted User',
        email: null,
        phoneNumber: null,
        passwordHash: null,
        paystackCustomerCode: null,
        paystackCustomerEmail: null,
        deletedAt: expect.any(Date),
      }),
    });
    expect(tx.requestMedia.findMany).toHaveBeenCalledWith({
      where: {
        rescueRequest: { customerId: 'user-1' },
        uploadedByRole: 'CUSTOMER',
      },
      select: { id: true, s3Key: true },
    });
    expect(tx.pendingMediaDeletion.createMany).toHaveBeenCalledWith({
      data: [{ s3Key: 'key-1' }],
      skipDuplicates: true,
    });
    expect(tx.requestMedia.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-1'] } },
    });
    expect(tx.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: { customerId: 'user-1' },
      data: {
        latitude: null,
        longitude: null,
        destination: null,
        customerDisputeStatement: null,
        operatorDisputeStatement: null,
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        category: 'account_deleted',
        message: 'User user-1 deleted',
        actorId: 'admin-1',
        details: { targetType: 'User', targetId: 'user-1' },
      },
    });
  });

  it('deletes S3 after commit and clears the outbox only on success', async () => {
    tx.requestMedia.findMany.mockResolvedValue([
      { id: 'media-1', s3Key: 'key-1' },
    ]);
    let committed = false;
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const result = await callback(tx);
        committed = true;
        return result;
      },
    );
    s3Service.deleteObject.mockImplementation(() => {
      expect(committed).toBe(true);
      return Promise.resolve();
    });

    await service.deleteUser('user-1', 'admin-1');

    expect(prisma.pendingMediaDeletion.delete).toHaveBeenCalledWith({
      where: { s3Key: 'key-1' },
    });
  });

  it('keeps the outbox row and resolves when S3 deletion fails', async () => {
    tx.requestMedia.findMany.mockResolvedValue([
      { id: 'media-1', s3Key: 'key-1' },
    ]);
    s3Service.deleteObject.mockRejectedValue(new Error('S3 down'));

    await expect(
      service.deleteUser('user-1', 'admin-1'),
    ).resolves.toBeUndefined();
    expect(prisma.pendingMediaDeletion.delete).not.toHaveBeenCalled();
  });

  describe('deleteOperator', () => {
    it('locks only operator columns before reading request guards', async () => {
      await service.deleteOperator('op-1', 'admin-1');

      expect(tx.operator.updateMany).toHaveBeenCalledWith({
        where: { id: 'op-1', deletedAt: null },
        data: { updatedAt: expect.any(Date) },
      });
      expect(tx.operator.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.rescueRequest.findMany.mock.invocationCallOrder[0],
      );
    });

    it.each([
      [null, 'Operator not found'],
      [{ deletedAt: new Date() }, 'already been deleted'],
    ])('explains a failed operator lock for %p', async (operator, message) => {
      tx.operator.updateMany.mockResolvedValue({ count: 0 });
      tx.operator.findUnique.mockResolvedValue(operator);

      await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
        message,
      );
      expect(tx.rescueRequest.findMany).not.toHaveBeenCalled();
    });

    it('blocks active or unresolved-dispute requests', async () => {
      tx.rescueRequest.findMany.mockResolvedValueOnce([{ id: 'req-1' }]);

      await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
        '1 request(s) still active or disputed',
      );
      expect(tx.operator.update).not.toHaveBeenCalled();
    });

    it('blocks completed jobs without a successful payout sibling', async () => {
      tx.rescueRequest.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'req-1' }]);

      await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
        '1 completed request(s) still have an unsettled payout',
      );
      expect(tx.rescueRequest.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          assignedOperatorId: 'op-1',
          status: 'COMPLETED',
          payments: { none: { type: 'PAYOUT', status: 'SUCCEEDED' } },
        },
        select: { id: true },
      });
      expect(tx.operator.update).not.toHaveBeenCalled();
    });

    // A CANCELLED request with an assigned operator and a paid deposit,
    // where resolveCancellationSettlement was never called, still owes
    // this operator their share of the deposit — deleting nulls
    // paystackRecipientCode, which can never be restored, permanently
    // stranding that payout. Neither the "active" check above (which
    // excludes CANCELLED outright) nor the completed-payout check catches
    // this — it needed its own guard.
    it('blocks a cancelled request with a paid deposit that still needs a cancellation settlement', async () => {
      tx.rescueRequest.findMany
        .mockResolvedValueOnce([]) // blockingRequests
        .mockResolvedValueOnce([]) // unsettledPayouts (COMPLETED-only)
        .mockResolvedValueOnce([{ id: 'req-1' }]); // unsettled cancellations

      await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
        '1 cancelled request(s) still have an unsettled cancellation payout',
      );
      expect(tx.rescueRequest.findMany).toHaveBeenNthCalledWith(3, {
        where: {
          assignedOperatorId: 'op-1',
          status: 'CANCELLED',
          cancellationSettledAt: null,
          payments: { some: { type: 'DEPOSIT', status: 'SUCCEEDED' } },
        },
        select: { id: true },
      });
      expect(tx.operator.update).not.toHaveBeenCalled();
    });

    it('anonymizes the operator, scrubs statements, and queues only operator media', async () => {
      tx.requestMedia.findMany.mockResolvedValue([
        { id: 'media-1', s3Key: 'operator-key' },
      ]);

      await service.deleteOperator('op-1', 'admin-1');

      expect(tx.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: expect.objectContaining({
          businessName: 'Deleted Operator',
          contactName: 'Deleted Operator',
          phoneNumber: null,
          email: null,
          address: '',
          paystackRecipientCode: null,
          status: 'SUSPENDED',
          isAvailable: false,
          deletedAt: expect.any(Date),
        }),
      });
      expect(tx.rescueRequest.updateMany).toHaveBeenCalledWith({
        where: { assignedOperatorId: 'op-1' },
        data: {
          operatorDisputeStatement: null,
          customerDisputeStatement: null,
        },
      });
      expect(tx.requestMedia.findMany).toHaveBeenCalledWith({
        where: {
          rescueRequest: { assignedOperatorId: 'op-1' },
          uploadedByRole: 'OPERATOR',
        },
        select: { id: true, s3Key: true },
      });
      expect(tx.pendingMediaDeletion.createMany).toHaveBeenCalledWith({
        data: [{ s3Key: 'operator-key' }],
        skipDuplicates: true,
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: {
          category: 'account_deleted',
          message: 'Operator op-1 deleted',
          actorId: 'admin-1',
          details: { targetType: 'Operator', targetId: 'op-1' },
        },
      });
      expect(s3Service.deleteObject).toHaveBeenCalledWith('operator-key');
    });

    describe('owner/member user cascade', () => {
      const member = (userId: string) => ({ userId });
      const asMembers = (...ids: string[]) =>
        tx.operatorMember.findMany.mockResolvedValue(ids.map(member));

      it('locks member users (in id order) BEFORE the operator row, so lock order matches lockActiveMembership', async () => {
        asMembers('a-1', 'b-2');

        await service.deleteOperator('op-1', 'admin-1');

        const userLockOrder = tx.user.updateMany.mock.invocationCallOrder;
        const operatorLockOrder =
          tx.operator.updateMany.mock.invocationCallOrder;
        expect(userLockOrder.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...userLockOrder.slice(0, 2))).toBeLessThan(
          operatorLockOrder[0],
        );
        expect(tx.operatorMember.findMany).toHaveBeenNthCalledWith(1, {
          where: { operatorId: 'op-1' },
          select: { userId: true },
          orderBy: { userId: 'asc' },
        });
      });

      it('anonymizes the user of a sole-membership OPERATOR in the same transaction', async () => {
        asMembers('owner-1');
        tx.operatorMember.count.mockResolvedValue(0);
        tx.user.findUnique.mockResolvedValue({ role: 'OPERATOR' });

        await service.deleteOperator('op-1', 'admin-1');

        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: 'owner-1', deletedAt: null },
          data: { updatedAt: anyDate },
        });
        expect(tx.user.update).toHaveBeenCalledWith({
          where: { id: 'owner-1' },
          data: expect.objectContaining({
            name: 'Deleted User',
            email: null,
            phoneNumber: null,
            passwordHash: null,
            deletedAt: anyDate,
          }) as Record<string, unknown>,
        });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
          data: {
            category: 'account_deleted',
            message: 'User owner-1 deleted',
            actorId: 'admin-1',
            details: {
              targetType: 'User',
              targetId: 'owner-1',
              cascadedFromOperatorId: 'op-1',
            },
          },
        });
      });

      it('counts other memberships only AFTER that user row is locked', async () => {
        asMembers('owner-1');
        tx.operatorMember.count.mockResolvedValue(0);
        tx.user.findUnique.mockResolvedValue({ role: 'OPERATOR' });

        await service.deleteOperator('op-1', 'admin-1');

        expect(tx.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          tx.operatorMember.count.mock.invocationCallOrder[0],
        );
      });

      it('leaves a user who still belongs to another active operator', async () => {
        asMembers('shared-1');
        tx.operatorMember.count.mockResolvedValue(1);

        await service.deleteOperator('op-1', 'admin-1');

        expect(tx.operatorMember.count).toHaveBeenCalledWith({
          where: {
            userId: 'shared-1',
            operatorId: { not: 'op-1' },
            operator: { deletedAt: null },
          },
        });
        expect(tx.user.update).not.toHaveBeenCalled();
      });

      it('skips a member who is not an OPERATOR-role user', async () => {
        asMembers('cust-1');
        tx.operatorMember.count.mockResolvedValue(0);
        tx.user.findUnique.mockResolvedValue({ role: 'CUSTOMER' });

        await service.deleteOperator('op-1', 'admin-1');

        expect(tx.user.update).not.toHaveBeenCalled();
      });

      it('skips a member user who was already deleted', async () => {
        asMembers('gone-1');
        tx.user.updateMany.mockResolvedValue({ count: 0 });

        await service.deleteOperator('op-1', 'admin-1');

        expect(tx.user.update).not.toHaveBeenCalled();
      });

      it('aborts when someone joined the team between the first read and the operator lock', async () => {
        tx.operatorMember.findMany
          .mockResolvedValueOnce([member('a-1')])
          .mockResolvedValueOnce([member('a-1'), member('late-2')]);
        tx.operatorMember.count.mockResolvedValue(0);
        tx.user.findUnique.mockResolvedValue({ role: 'OPERATOR' });

        await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
          'team changed while it was being deleted',
        );
      });

      it('refuses the whole deletion when a member still has an active customer-side request', async () => {
        asMembers('owner-1');
        tx.operatorMember.count.mockResolvedValue(0);
        tx.user.findUnique.mockResolvedValue({ role: 'OPERATOR' });
        // operator guards: active, unsettled payouts, unsettled cancellations
        // (all clear), then the member's own customer-side guard
        tx.rescueRequest.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'req-9' }]);

        await expect(service.deleteOperator('op-1', 'admin-1')).rejects.toThrow(
          'still has 1 active',
        );
        expect(tx.user.update).not.toHaveBeenCalled();
      });
    });

    it('keeps the operator-media outbox row when S3 fails', async () => {
      tx.requestMedia.findMany.mockResolvedValue([
        { id: 'media-1', s3Key: 'operator-key' },
      ]);
      s3Service.deleteObject.mockRejectedValue(new Error('S3 down'));

      await expect(
        service.deleteOperator('op-1', 'admin-1'),
      ).resolves.toBeUndefined();
      expect(prisma.pendingMediaDeletion.delete).not.toHaveBeenCalled();
    });
  });
});
