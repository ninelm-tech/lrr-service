import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

// Typed once so the matcher does not surface as an `any` assignment.
const anyDate = expect.any(Date) as Date;

describe('Operator delete cascades to its users (integration)', () => {
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

  async function operatorUser(phoneNumber: string, name = 'Real Person') {
    return prisma.user.create({
      data: {
        phoneNumber,
        email: `${phoneNumber.slice(-6)}@example.com`,
        passwordHash: 'hash',
        name,
        role: 'OPERATOR',
      },
    });
  }

  async function join(
    userId: string,
    operatorId: string,
    role: 'OWNER' | 'MANAGER' | 'STAFF',
  ) {
    return prisma.operatorMember.create({
      data: { userId, operatorId, role },
    });
  }

  it('anonymizes the business AND its owner and staff logins, keeping membership rows', async () => {
    const operator = await createOperator(prisma);
    const owner = await operatorUser('+2349011110001');
    const staff = await operatorUser('+2349011110002');
    await join(owner.id, operator.id, 'OWNER');
    await join(staff.id, operator.id, 'STAFF');

    await service.deleteOperator(operator.id, 'admin-1');

    const op = await prisma.operator.findUniqueOrThrow({
      where: { id: operator.id },
    });
    expect(op.deletedAt).not.toBeNull();
    expect(op.businessName).toBe('Deleted Operator');

    for (const id of [owner.id, staff.id]) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(u).toMatchObject({
        name: 'Deleted User',
        email: null,
        phoneNumber: null,
        passwordHash: null,
        deletedAt: anyDate,
      });
    }
    expect(await prisma.operatorMember.count()).toBe(2);

    const audits = await prisma.auditLog.findMany({
      where: { category: 'account_deleted' },
    });
    expect(audits).toHaveLength(3); // operator + 2 users
    expect(
      audits.filter(
        (a) =>
          (a.details as { cascadedFromOperatorId?: string })
            ?.cascadedFromOperatorId === operator.id,
      ),
    ).toHaveLength(2);
  });

  it('leaves a user who also belongs to another active operator untouched', async () => {
    const doomed = await createOperator(prisma);
    const other = await createOperator(prisma);
    const shared = await operatorUser('+2349011110003', 'Shared Person');
    await join(shared.id, doomed.id, 'MANAGER');
    await join(shared.id, other.id, 'MANAGER');

    await service.deleteOperator(doomed.id, 'admin-1');

    const u = await prisma.user.findUniqueOrThrow({ where: { id: shared.id } });
    expect(u.deletedAt).toBeNull();
    expect(u.name).toBe('Shared Person');
    expect(u.passwordHash).toBe('hash');
  });

  it('still removes a shared user once their OTHER operator is already deleted', async () => {
    const first = await createOperator(prisma);
    const second = await createOperator(prisma);
    const person = await operatorUser('+2349011110004');
    await join(person.id, first.id, 'OWNER');
    await join(person.id, second.id, 'OWNER');

    await service.deleteOperator(first.id, 'admin-1'); // still active in second
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: person.id } }))
        .deletedAt,
    ).toBeNull();

    await service.deleteOperator(second.id, 'admin-1'); // now their last one
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: person.id } }))
        .deletedAt,
    ).not.toBeNull();
  });

  it('does not touch a member whose role is not OPERATOR', async () => {
    const operator = await createOperator(prisma);
    const customer = await createCustomer(prisma, '+2349011110005');
    await join(customer.id, operator.id, 'STAFF');

    await service.deleteOperator(operator.id, 'admin-1');

    const u = await prisma.user.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(u.deletedAt).toBeNull();
    expect(u.phoneNumber).toBe('+2349011110005');
  });

  it('refuses everything — operator included — when a member has an active request of their own', async () => {
    const operator = await createOperator(prisma);
    const owner = await operatorUser('+2349011110006');
    await join(owner.id, operator.id, 'OWNER');
    await createRequest(prisma, owner.id, { status: 'DISPATCHING' });

    await expect(
      service.deleteOperator(operator.id, 'admin-1'),
    ).rejects.toThrow('still has 1 active request');

    // The whole transaction rolled back.
    const op = await prisma.operator.findUniqueOrThrow({
      where: { id: operator.id },
    });
    expect(op.deletedAt).toBeNull();
    expect(op.businessName).toBe('Swift Towing');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(u.deletedAt).toBeNull();
    expect(u.passwordHash).toBe('hash');
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('rolls back the users too when the final audit write fails', async () => {
    const operator = await createOperator(prisma);
    const owner = await operatorUser('+2349011110007');
    await join(owner.id, operator.id, 'OWNER');
    const failing = prisma.$extends({
      query: {
        auditLog: {
          create({ args, query }) {
            const category = (
              args.data as { details?: { targetType?: string } }
            ).details?.targetType;
            if (category === 'Operator') {
              throw new Error('Simulated audit-log failure');
            }
            return query(args);
          },
        },
      },
    });
    const failingService = new AccountDeletionService(
      failing as unknown as PrismaService,
      { deleteObject: jest.fn() } as never,
    );

    await expect(
      failingService.deleteOperator(operator.id, 'admin-1'),
    ).rejects.toThrow('Simulated audit-log failure');

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }))
        .deletedAt,
    ).toBeNull();
    expect(
      (await prisma.operator.findUniqueOrThrow({ where: { id: operator.id } }))
        .deletedAt,
    ).toBeNull();
  });

  describe('DELETE users/:id rules', () => {
    it('refuses a member of a live operator and points at the Operators page', async () => {
      const operator = await createOperator(prisma);
      const member = await operatorUser('+2349011110008');
      await join(member.id, operator.id, 'MANAGER');

      await expect(service.deleteUser(member.id, 'admin-1')).rejects.toThrow(
        'delete the operator from the Operators page',
      );
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: member.id } }))
          .deletedAt,
      ).toBeNull();
    });

    it('deletes an orphan OPERATOR user with no active membership', async () => {
      const orphan = await operatorUser('+2349011110009');
      await service.deleteUser(orphan.id, 'admin-1');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: orphan.id } }))
          .deletedAt,
      ).not.toBeNull();
    });

    it('deletes a user whose only operator was already deleted', async () => {
      const operator = await createOperator(prisma);
      const member = await operatorUser('+2349011110010');
      await join(member.id, operator.id, 'STAFF');
      await prisma.operator.update({
        where: { id: operator.id },
        data: { deletedAt: new Date() },
      });

      await service.deleteUser(member.id, 'admin-1');

      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: member.id } }))
          .deletedAt,
      ).not.toBeNull();
    });

    it('refuses staff roles outright', async () => {
      const admin = await prisma.user.create({
        data: { email: 'a@example.com', role: 'ADMIN', name: 'Boss' },
      });
      await expect(service.deleteUser(admin.id, 'admin-1')).rejects.toThrow(
        'Only customer and operator accounts',
      );
    });
  });
});
