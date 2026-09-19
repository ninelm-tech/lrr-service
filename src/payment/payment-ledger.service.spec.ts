import { Test, TestingModule } from '@nestjs/testing';
import { PaymentLedgerService } from './payment-ledger.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaymentLedgerService', () => {
  let service: PaymentLedgerService;
  let prisma: {
    payment: { create: jest.Mock };
    operator: { updateMany: jest.Mock };
    user: { updateMany: jest.Mock };
    rescueRequest: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      payment: { create: jest.fn() },
      operator: { updateMany: jest.fn() },
      user: { updateMany: jest.fn() },
      rescueRequest: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentLedgerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PaymentLedgerService>(PaymentLedgerService);
  });

  describe('create', () => {
    it('refuses a PAYOUT for a deleted operator', async () => {
      prisma.operator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.create({
          rescueRequestId: 'req-1',
          type: 'PAYOUT',
          amount: 500000,
          operatorId: 'op-1',
        }),
      ).rejects.toThrow(
        'Cannot create a payout: this operator has been deleted.',
      );

      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('refuses a DEPOSIT for a request whose customer is deleted', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
      });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.create({
          rescueRequestId: 'req-1',
          type: 'DEPOSIT',
          amount: 500000,
        }),
      ).rejects.toThrow(
        'Cannot create this payment: the customer has been deleted.',
      );

      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('creates the payment when the operator is still active', async () => {
      prisma.operator.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.create.mockResolvedValue({ id: 'pay-1' });

      const result = await service.create({
        rescueRequestId: 'req-1',
        type: 'PAYOUT',
        amount: 500000,
        operatorId: 'op-1',
      });

      expect(result).toEqual({ id: 'pay-1' });
    });

    it('opens its own transaction when the caller passed no tx', async () => {
      prisma.operator.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.create.mockResolvedValue({ id: 'pay-1' });

      await service.create({
        rescueRequestId: 'req-1',
        type: 'PAYOUT',
        amount: 500000,
        operatorId: 'op-1',
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('rejects a PAYOUT with no operatorId outright, rather than silently falling through to the customer-side check', async () => {
      // A malformed call: without this rejection, `type === PAYOUT && operatorId`
      // would be false (falsy operatorId), sending it down the customer branch
      // — which checks the WRONG party's deletedAt (the request's customer,
      // not any operator) and would then insert a payout row with
      // operatorId: null. This must fail before either branch's lock runs.
      await expect(
        service.create({
          rescueRequestId: 'req-1',
          type: 'PAYOUT',
          amount: 500000,
        }),
      ).rejects.toThrow('A PAYOUT payment must have an operatorId.');

      expect(prisma.rescueRequest.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });
});
