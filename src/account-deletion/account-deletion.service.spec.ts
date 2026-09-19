import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';
import { AccountDeletionService } from './account-deletion.service';

describe('AccountDeletionService.deleteUser', () => {
  let service: AccountDeletionService;
  let tx: {
    user: { updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    rescueRequest: { findMany: jest.Mock; updateMany: jest.Mock };
    operatorMember: { findMany: jest.Mock };
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
      rescueRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      operatorMember: { findMany: jest.fn().mockResolvedValue([]) },
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
  ])('explains a failed parent lock for %p', async (user, message) => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue(user);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      message,
    );
    expect(tx.rescueRequest.findMany).not.toHaveBeenCalled();
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
});
