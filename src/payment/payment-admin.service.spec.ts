import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { PaymentAdminService } from './payment-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorMembershipService } from '../operator/operator-membership.service';
import { PaymentStatus, PaymentType } from '@prisma/client';

describe('PaymentAdminService', () => {
  let service: PaymentAdminService;
  let prisma: {
    payment: {
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };
  let operatorMembershipService: { findActiveOperatorIdsForUser: jest.Mock };

  const rawPayment = {
    id: 'pay-1',
    type: PaymentType.DEPOSIT,
    status: PaymentStatus.SUCCEEDED,
    amount: 500000,
    currency: 'NGN',
    providerFee: 100,
    netAmount: 499900,
    failureReason: null,
    blockReason: null,
    checkoutUrl: null,
    verifyAttempts: 0,
    createdAt: new Date('2026-09-23T00:00:00Z'),
    settledAt: new Date('2026-09-23T00:01:00Z'),
    rescueRequestId: 'req-1',
    operatorId: null,
    operator: null,
    rescueRequest: {
      customer: { id: 'cust-1', phoneNumber: '+2348000000000' },
      assignedOperator: { id: 'op-1', businessName: 'Acme Tow' },
    },
  };

  beforeEach(async () => {
    prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([rawPayment]),
        count: jest.fn().mockResolvedValue(1),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    operatorMembershipService = { findActiveOperatorIdsForUser: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentAdminService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: OperatorMembershipService,
          useValue: operatorMembershipService,
        },
      ],
    }).compile();

    service = module.get<PaymentAdminService>(PaymentAdminService);
  });

  describe('listForUser', () => {
    it('lets SUPER_ADMIN see every payment, shaped as list items', async () => {
      const result = await service.listForUser(
        { userId: 'admin-1', role: 'SUPER_ADMIN' },
        {},
      );

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(result).toEqual({
        data: [
          {
            id: 'pay-1',
            type: PaymentType.DEPOSIT,
            status: PaymentStatus.SUCCEEDED,
            amount: 500000,
            currency: 'NGN',
            providerFee: 100,
            netAmount: 499900,
            failureReason: null,
            blockReason: null,
            checkoutUrl: null,
            verifyAttempts: 0,
            createdAt: rawPayment.createdAt,
            settledAt: rawPayment.settledAt,
            rescueRequestId: 'req-1',
            customer: { id: 'cust-1', phoneNumber: '+2348000000000' },
            assignedOperator: { id: 'op-1', businessName: 'Acme Tow' },
            payoutOperator: null,
          },
        ],
        meta: { page: 1, limit: 20, total: 1 },
      });
    });

    it('scopes OPERATOR to payments on requests assigned to their own operator(s)', async () => {
      operatorMembershipService.findActiveOperatorIdsForUser.mockResolvedValue([
        'op-1',
        'op-2',
      ]);

      await service.listForUser({ userId: 'user-1', role: 'OPERATOR' }, {});

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            rescueRequest: { assignedOperatorId: { in: ['op-1', 'op-2'] } },
          },
        }),
      );
    });

    it('short-circuits with an empty page for an OPERATOR with no active operator', async () => {
      operatorMembershipService.findActiveOperatorIdsForUser.mockResolvedValue(
        [],
      );

      const result = await service.listForUser(
        { userId: 'user-1', role: 'OPERATOR' },
        {},
      );

      expect(prisma.payment.findMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      });
    });

    it('rejects a CUSTOMER — this view is staff/operator only', async () => {
      await expect(
        service.listForUser({ userId: 'cust-1', role: 'CUSTOMER' }, {}),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('applies type/status/date filters on top of role scoping', async () => {
      await service.listForUser(
        { userId: 'admin-1', role: 'ADMIN' },
        {
          type: PaymentType.PAYOUT,
          status: PaymentStatus.FAILED,
          from: '2026-09-01',
          to: '2026-09-30',
        },
      );

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: PaymentType.PAYOUT,
            status: PaymentStatus.FAILED,
            createdAt: {
              gte: new Date('2026-09-01'),
              lte: new Date('2026-09-30'),
            },
          },
        }),
      );
    });

    it('coerces page/limit to real numbers — Express query params arrive as strings and there is no global ValidationPipe', async () => {
      const result = await service.listForUser(
        { userId: 'admin-1', role: 'SUPER_ADMIN' },
        { page: '2' as unknown as number, limit: '10' as unknown as number },
      );

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 1 });
    });
  });

  describe('summaryForUser', () => {
    it('buckets SUCCEEDED as collected and in-flight statuses as pending, deposit vs balance', async () => {
      prisma.payment.groupBy.mockResolvedValue([
        { type: 'DEPOSIT', status: 'SUCCEEDED', _sum: { amount: 500000 } },
        { type: 'BALANCE', status: 'SUCCEEDED', _sum: { amount: 4500000 } },
        { type: 'DEPOSIT', status: 'PENDING', _sum: { amount: 23000 } },
        { type: 'BALANCE', status: 'SUBMITTED', _sum: { amount: 115000 } },
        // Not a deposit/balance collection — must not leak into these totals.
        { type: 'PAYOUT', status: 'SUCCEEDED', _sum: { amount: 999999 } },
      ]);

      const result = await service.summaryForUser(
        { userId: 'admin-1', role: 'SUPER_ADMIN' },
        {},
      );

      expect(result).toEqual({
        depositCollected: 500000,
        balanceCollected: 4500000,
        totalCollected: 5000000,
        depositPending: 23000,
        balancePending: 115000,
        totalOutstanding: 138000,
      });
    });

    it('rejects a CUSTOMER the same way listForUser does', async () => {
      await expect(
        service.summaryForUser({ userId: 'cust-1', role: 'CUSTOMER' }, {}),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
