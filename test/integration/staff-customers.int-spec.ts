import { StaffService } from '../../src/staff/staff.service';
import { CustomersService } from '../../src/customers/customers.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOperator, truncateAll } from './factories';

describe('Staff and customers admin (integration)', () => {
  let prisma: PrismaService;
  let staff: StaffService;
  let customers: CustomersService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    staff = new StaffService(prisma);
    customers = new CustomersService(prisma);
  });

  describe('StaffService', () => {
    async function seed() {
      const superAdmin = await prisma.user.create({
        data: { email: 'root@example.com', role: 'SUPER_ADMIN', name: 'Root' },
      });
      const admin = await prisma.user.create({
        data: { email: 'admin@example.com', role: 'ADMIN', name: 'Admin' },
      });
      const product = await prisma.user.create({
        data: { email: 'prod@example.com', role: 'PRODUCT', name: 'Prod' },
      });
      const customer = await createCustomer(prisma, '+2348000000001');
      const opUser = await prisma.user.create({
        data: { phoneNumber: '+2349000000001', role: 'OPERATOR', name: 'Op' },
      });
      const deleted = await prisma.user.create({
        data: { role: 'ADMIN', name: 'Gone', deletedAt: new Date() },
      });
      return { superAdmin, admin, product, customer, opUser, deleted };
    }

    it('lists only live internal roles — no customers, operators or deleted', async () => {
      const s = await seed();

      const res = await staff.list({ page: 1, limit: 25 });

      const ids = res.data.map((u) => u.id).sort();
      expect(ids).toEqual([s.superAdmin.id, s.admin.id, s.product.id].sort());
      expect(res.meta.total).toBe(3);
      expect(res.data[0]).not.toHaveProperty('passwordHash');
    });

    it('searches by name or email', async () => {
      await seed();
      const res = await staff.list({ page: 1, limit: 25, search: 'PROD' });
      expect(res.data.map((u) => u.email)).toEqual(['prod@example.com']);
    });

    it('promotes PRODUCT to ADMIN and renames, persisting both', async () => {
      const s = await seed();

      const res = await staff.update(
        s.product.id,
        { role: 'ADMIN', name: '  New Name ' },
        s.superAdmin.id,
      );

      expect(res.before).toEqual({ role: 'PRODUCT', name: 'Prod' });
      expect(res.after).toEqual({ role: 'ADMIN', name: 'New Name' });
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: s.product.id },
      });
      expect(row).toMatchObject({ role: 'ADMIN', name: 'New Name' });
    });

    it('never lets a SUPER_ADMIN be edited, or anyone be made one', async () => {
      const s = await seed();

      await expect(
        staff.update(s.superAdmin.id, { name: 'X' }, s.admin.id),
      ).rejects.toThrow('Staff member not found');
      await expect(
        staff.update(s.admin.id, { role: 'SUPER_ADMIN' }, s.superAdmin.id),
      ).rejects.toThrow('role must be ADMIN or PRODUCT');

      const roles = await prisma.user.findMany({
        where: { id: { in: [s.superAdmin.id, s.admin.id] } },
        select: { id: true, role: true },
      });
      expect(roles.find((r) => r.id === s.superAdmin.id)?.role).toBe(
        'SUPER_ADMIN',
      );
      expect(roles.find((r) => r.id === s.admin.id)?.role).toBe('ADMIN');
    });

    it('refuses self-edit, customers, operators and deleted accounts', async () => {
      const s = await seed();

      await expect(
        staff.update(s.admin.id, { role: 'PRODUCT' }, s.admin.id),
      ).rejects.toThrow('your own account');
      for (const id of [s.customer.id, s.opUser.id, s.deleted.id]) {
        await expect(
          staff.update(id, { role: 'ADMIN' }, s.superAdmin.id),
        ).rejects.toThrow('Staff member not found');
      }
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: s.customer.id } }))
          .role,
      ).toBe('CUSTOMER');
    });
  });

  describe('CustomersService', () => {
    it('lists only customers (deleted ones flagged), never staff or operators', async () => {
      const c1 = await createCustomer(prisma, '+2348000000011');
      const c2 = await prisma.user.create({
        data: {
          phoneNumber: '+2348000000012',
          role: 'CUSTOMER',
          name: 'Deleted User',
          deletedAt: new Date(),
        },
      });
      await prisma.user.create({
        data: { email: 'a@example.com', role: 'ADMIN' },
      });
      await prisma.user.create({
        data: { phoneNumber: '+2349000000011', role: 'OPERATOR' },
      });
      await createOperator(prisma);

      const res = await customers.list({ page: 1, limit: 25 });

      expect(res.data.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());
      expect(res.data.find((c) => c.id === c2.id)?.deletedAt).not.toBeNull();
      expect(res.data[0]).not.toHaveProperty('passwordHash');
    });

    it('edits name and email but never the phone number', async () => {
      const c = await createCustomer(prisma, '+2348000000021');

      await customers.update(c.id, {
        name: ' Ada Obi ',
        email: ' Ada@Example.COM ',
        phoneNumber: '+2348999999999',
      } as never);

      const row = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toMatchObject({
        name: 'Ada Obi',
        email: 'ada@example.com',
        phoneNumber: '+2348000000021',
      });
    });

    it('rejects an email held by another account, including a legacy mixed-case one', async () => {
      await prisma.user.create({
        data: { email: 'Taken@Example.com', role: 'CUSTOMER' },
      });
      const c = await createCustomer(prisma, '+2348000000031');

      await expect(
        customers.update(c.id, { email: 'taken@example.com' }),
      ).rejects.toThrow('already in use');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).email,
      ).toBeNull();
    });

    it('maps a real unique-index race to a 409, not a 500', async () => {
      const a = await createCustomer(prisma, '+2348000000041');
      const b = await createCustomer(prisma, '+2348000000042');

      const results = await Promise.allSettled([
        customers.update(a.id, { email: 'race@example.com' }),
        customers.update(b.id, { email: 'race@example.com' }),
      ]);

      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected.length).toBeLessThanOrEqual(1);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({
          status: 409,
        });
      }
      expect(
        await prisma.user.count({ where: { email: 'race@example.com' } }),
      ).toBe(1);
    });

    it('cannot edit a staff user, an operator user or a deleted customer', async () => {
      const admin = await prisma.user.create({
        data: { email: 'x@example.com', role: 'ADMIN' },
      });
      const op = await prisma.user.create({
        data: { phoneNumber: '+2349000000051', role: 'OPERATOR' },
      });
      const gone = await prisma.user.create({
        data: { role: 'CUSTOMER', deletedAt: new Date() },
      });

      for (const id of [admin.id, op.id, gone.id]) {
        await expect(customers.update(id, { name: 'X' })).rejects.toThrow(
          'Customer not found',
        );
      }
    });
  });
});
