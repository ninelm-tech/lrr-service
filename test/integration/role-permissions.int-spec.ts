import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AccountDeletionController } from '../../src/account-deletion/account-deletion.controller';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { AuditLogService } from '../../src/audit-log/audit-log.service';
import { AuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/guards/roles.guard';
import { CustomersController } from '../../src/customers/customers.controller';
import { CustomersService } from '../../src/customers/customers.service';
import { PaystackService } from '../../src/integrations/paystack/paystack.service';
import { S3Service } from '../../src/integrations/s3/s3.service';
import { OperatorController } from '../../src/operator/operator.controller';
import { OperatorMembershipService } from '../../src/operator/operator-membership.service';
import { OperatorService } from '../../src/operator/operator.service';
import { OtpService } from '../../src/otp/otp.service';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StaffController } from '../../src/staff/staff.controller';
import { StaffService } from '../../src/staff/staff.service';
import { createCustomer, createOperator, truncateAll } from './factories';

/**
 * Real controllers, real AuthGuard/RolesGuard, real JWTs, real Postgres —
 * only the outside world (Paystack, S3, OTP) is stubbed. This is the layer
 * the unit tests can't see: whether a given ROLE actually gets through a
 * given ROUTE.
 */
// Typed once so the matcher does not surface as an `any` assignment.
const anyDate = expect.any(Date) as Date;

describe('Role permissions over HTTP (integration)', () => {
  const SECRET = 'int-test-secret';
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  const paystack = {
    resolveAccountNumber: jest.fn(),
    createTransferRecipient: jest.fn(),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      controllers: [
        OperatorController,
        StaffController,
        CustomersController,
        AccountDeletionController,
      ],
      providers: [
        { provide: PrismaService, useValue: prisma },
        OperatorService,
        OperatorMembershipService,
        PlatformConfigService,
        StaffService,
        CustomersService,
        AccountDeletionService,
        AuditLogService,
        AuthGuard,
        RolesGuard,
        { provide: PaystackService, useValue: paystack },
        { provide: OtpService, useValue: {} },
        { provide: S3Service, useValue: { deleteObject: jest.fn() } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  let operatorId: string;
  let otherOperatorId: string;
  let ids: {
    superAdmin: string;
    admin: string;
    product: string;
    customer: string;
    owner: string;
    staffTarget: string;
  };

  const tokenFor = (userId: string, role: string) =>
    jwt.sign({ sub: userId, role, phoneNumber: '+2340000000000' });
  const as = (userId: string, role: string) => ({
    Authorization: `Bearer ${tokenFor(userId, role)}`,
  });
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await truncateAll(prisma);
    paystack.resolveAccountNumber.mockReset().mockResolvedValue({
      accountName: 'JOHN DOE',
    });
    paystack.createTransferRecipient.mockReset().mockResolvedValue({
      recipientCode: 'RCP_1',
    });

    const mk = (role: 'SUPER_ADMIN' | 'ADMIN' | 'PRODUCT', email: string) =>
      prisma.user.create({ data: { email, role, name: role } });
    const superAdmin = await mk('SUPER_ADMIN', 'root@example.com');
    const admin = await mk('ADMIN', 'admin@example.com');
    const product = await mk('PRODUCT', 'product@example.com');
    const staffTarget = await mk('PRODUCT', 'other-product@example.com');
    const customer = await createCustomer(prisma, '+2348000000001');
    const owner = await prisma.user.create({
      data: { phoneNumber: '+2349000000001', role: 'OPERATOR', name: 'Owner' },
    });
    const op = await createOperator(prisma);
    const other = await createOperator(prisma);
    await prisma.operatorMember.create({
      data: { userId: owner.id, operatorId: op.id, role: 'OWNER' },
    });
    operatorId = op.id;
    otherOperatorId = other.id;
    ids = {
      superAdmin: superAdmin.id,
      admin: admin.id,
      product: product.id,
      customer: customer.id,
      owner: owner.id,
      staffTarget: staffTarget.id,
    };
  });

  const bank = {
    bankCode: '058',
    bankName: 'GTBank',
    accountNumber: '0123456789',
  };

  describe('unauthenticated', () => {
    it.each([
      ['patch', () => `/operators/${operatorId}/bank-details`],
      ['get', () => '/admin/staff'],
      ['get', () => '/admin/customers'],
      ['delete', () => `/operators/${operatorId}`],
    ])('%s %s is 401', async (method, path) => {
      const res = await (
        http() as never as Record<string, (p: string) => request.Test>
      )[method](path());
      expect(res.status).toBe(401);
    });
  });

  describe('PRODUCT — can onboard', () => {
    it('saves payout bank details, and the change is audit-logged without the full account number', async () => {
      const res = await http()
        .patch(`/operators/${operatorId}/bank-details`)
        .set(as(ids.product, 'PRODUCT'))
        .send(bank);

      expect(res.status).toBe(200);
      const op = await prisma.operator.findUniqueOrThrow({
        where: { id: operatorId },
      });
      expect(op).toMatchObject({
        bankName: 'GTBank',
        accountName: 'JOHN DOE',
        accountNumberLast4: '6789',
        paystackRecipientCode: 'RCP_1',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { category: 'operator_bank_details_saved' },
      });
      expect(audit.actorId).toBe(ids.product);
      expect(JSON.stringify(audit)).not.toContain('0123456789');
    });

    it('clears bank details', async () => {
      await http()
        .patch(`/operators/${operatorId}/bank-details`)
        .set(as(ids.product, 'PRODUCT'))
        .send(bank);

      const res = await http()
        .delete(`/operators/${operatorId}/bank-details`)
        .set(as(ids.product, 'PRODUCT'));

      expect(res.status).toBe(200);
      expect(
        (await prisma.operator.findUniqueOrThrow({ where: { id: operatorId } }))
          .bankName,
      ).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { category: 'operator_bank_details_cleared' },
        }),
      ).toBe(1);
    });

    it('edits the profile, audit-logging field names only', async () => {
      const res = await http()
        .patch(`/operators/${operatorId}`)
        .set(as(ids.product, 'PRODUCT'))
        .send({ address: '9 Secret Close' });

      expect(res.status).toBe(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { category: 'operator_profile_updated' },
      });
      expect(audit.details).toMatchObject({ changedFields: ['address'] });
      expect(JSON.stringify(audit)).not.toContain('Secret Close');
    });

    it('toggles availability', async () => {
      const res = await http()
        .patch(`/operators/${operatorId}/availability`)
        .set(as(ids.product, 'PRODUCT'))
        .send({ isAvailable: false });
      expect(res.status).toBe(200);
      expect(
        (await prisma.operator.findUniqueOrThrow({ where: { id: operatorId } }))
          .isAvailable,
      ).toBe(false);
    });
  });

  describe('PRODUCT — cannot do anything else', () => {
    it('is refused (403) on verify/suspend, test flag, team, delete, staff and customers', async () => {
      const p = as(ids.product, 'PRODUCT');
      const calls: Array<[string, () => request.Test]> = [
        [
          'status',
          () =>
            http()
              .patch(`/operators/${operatorId}/status`)
              .set(p)
              .send({ status: 'SUSPENDED' }),
        ],
        [
          'is-test',
          () =>
            http()
              .patch(`/operators/${operatorId}/is-test`)
              .set(p)
              .send({ isTest: true }),
        ],
        [
          'add member',
          () =>
            http()
              .post(`/operators/${operatorId}/members`)
              .set(p)
              .send({ userId: ids.customer }),
        ],
        [
          'remove member',
          () =>
            http().delete(`/operators/${operatorId}/members/anything`).set(p),
        ],
        [
          'delete operator',
          () => http().delete(`/operators/${operatorId}`).set(p),
        ],
        ['delete user', () => http().delete(`/users/${ids.customer}`).set(p)],
        ['list staff', () => http().get('/admin/staff').set(p)],
        [
          'edit staff',
          () =>
            http()
              .patch(`/admin/staff/${ids.staffTarget}`)
              .set(p)
              .send({ role: 'ADMIN' }),
        ],
        ['list customers', () => http().get('/admin/customers').set(p)],
        [
          'edit customer',
          () =>
            http()
              .patch(`/admin/customers/${ids.customer}`)
              .set(p)
              .send({ name: 'X' }),
        ],
      ];

      for (const [label, call] of calls) {
        const res = await call();
        expect({ label, status: res.status }).toEqual({ label, status: 403 });
      }

      // And nothing actually changed.
      const op = await prisma.operator.findUniqueOrThrow({
        where: { id: operatorId },
      });
      expect(op).toMatchObject({ status: 'ACTIVE', deletedAt: null });
      expect(
        await prisma.user.count({ where: { deletedAt: { not: null } } }),
      ).toBe(0);
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: ids.staffTarget },
          })
        ).role,
      ).toBe('PRODUCT');
    });
  });

  describe('ADMIN', () => {
    it('can list staff and customers and edit a customer (audited)', async () => {
      const a = as(ids.admin, 'ADMIN');
      expect((await http().get('/admin/staff').set(a)).status).toBe(200);
      expect((await http().get('/admin/customers').set(a)).status).toBe(200);

      const res = await http()
        .patch(`/admin/customers/${ids.customer}`)
        .set(a)
        .send({ name: 'Ada Obi' });
      expect(res.status).toBe(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { category: 'customer_updated' },
      });
      expect(audit.actorId).toBe(ids.admin);
    });

    it('cannot edit staff roles or delete users/operators', async () => {
      const a = as(ids.admin, 'ADMIN');
      expect(
        (
          await http()
            .patch(`/admin/staff/${ids.staffTarget}`)
            .set(a)
            .send({ role: 'ADMIN' })
        ).status,
      ).toBe(403);
      expect(
        (await http().delete(`/users/${ids.customer}`).set(a)).status,
      ).toBe(403);
      expect(
        (await http().delete(`/operators/${operatorId}`).set(a)).status,
      ).toBe(403);
    });
  });

  describe('SUPER_ADMIN', () => {
    it('edits a staff role (audited with before/after) but never their own', async () => {
      const s = as(ids.superAdmin, 'SUPER_ADMIN');

      const ok = await http()
        .patch(`/admin/staff/${ids.staffTarget}`)
        .set(s)
        .send({ role: 'ADMIN' });
      expect(ok.status).toBe(200);
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: ids.staffTarget },
          })
        ).role,
      ).toBe('ADMIN');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { category: 'staff_updated' },
      });
      expect(audit.details).toMatchObject({
        before: { role: 'PRODUCT' },
        after: { role: 'ADMIN' },
      });

      const self = await http()
        .patch(`/admin/staff/${ids.superAdmin}`)
        .set(s)
        .send({ role: 'PRODUCT' });
      expect(self.status).toBe(403);
    });

    it('deleting an operator removes its owner login too, and deleting that user directly is refused', async () => {
      const s = as(ids.superAdmin, 'SUPER_ADMIN');

      const direct = await http().delete(`/users/${ids.owner}`).set(s);
      expect(direct.status).toBe(400);
      expect((direct.body as { message: string }).message).toContain(
        'Operators page',
      );

      const res = await http().delete(`/operators/${operatorId}`).set(s);
      expect(res.status).toBe(200);

      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ids.owner },
      });
      expect(owner).toMatchObject({
        name: 'Deleted User',
        phoneNumber: null,
        deletedAt: anyDate,
      });
    });
  });

  describe('operator owner (existing behaviour must not regress)', () => {
    it('can save bank details for their own operator but not another', async () => {
      const o = as(ids.owner, 'OPERATOR');
      expect(
        (
          await http()
            .patch(`/operators/${operatorId}/bank-details`)
            .set(o)
            .send(bank)
        ).status,
      ).toBe(200);
      expect(
        (
          await http()
            .patch(`/operators/${otherOperatorId}/bank-details`)
            .set(o)
            .send(bank)
        ).status,
      ).toBe(403);
    });
  });
});
