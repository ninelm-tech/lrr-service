import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { truncateAll } from './factories';

describe('AccountDeletionService (integration)', () => {
  let prisma: PrismaService;
  let service: AccountDeletionService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    service = new AccountDeletionService(prisma, {
      deleteObject: jest.fn(),
    } as never);
  });

  it('rolls back anonymization when the transactional audit write fails', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: '+2348011111111',
        role: 'CUSTOMER',
        name: 'Real Name',
      },
    });
    const failingPrisma = prisma.$extends({
      query: {
        auditLog: {
          create() {
            throw new Error('Simulated audit-log failure');
          },
        },
      },
    });
    const failingService = new AccountDeletionService(
      failingPrisma as unknown as PrismaService,
      { deleteObject: jest.fn() } as never,
    );

    await expect(failingService.deleteUser(user.id, 'admin-1')).rejects.toThrow(
      'Simulated audit-log failure',
    );

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.deletedAt).toBeNull();
    expect(after.name).toBe('Real Name');
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('commits anonymization and its audit row together on success', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: '+2348022222222',
        role: 'CUSTOMER',
        name: 'Real Name',
      },
    });

    await service.deleteUser(user.id, 'admin-1');

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after).toMatchObject({
      name: 'Deleted User',
      phoneNumber: null,
      deletedAt: expect.any(Date),
    });
    expect(await prisma.auditLog.findFirst()).toMatchObject({
      category: 'account_deleted',
      actorId: 'admin-1',
      details: { targetType: 'User', targetId: user.id },
    });
  });
});
