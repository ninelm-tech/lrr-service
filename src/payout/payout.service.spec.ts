import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: {
    payout: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
    operator: { findUnique: jest.Mock };
  };
  let paystack: {
    checkBalance: jest.Mock;
    initiateTransfer: jest.Mock;
    generateReference: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      payout: { create: jest.fn(), update: jest.fn().mockResolvedValue({}), findUnique: jest.fn() },
      operator: { findUnique: jest.fn() },
    };
    paystack = {
      checkBalance: jest.fn(),
      initiateTransfer: jest.fn(),
      generateReference: jest.fn().mockReturnValue('PAYOUT_test123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystack },
      ],
    }).compile();

    service = module.get<PayoutService>(PayoutService);
  });

  describe('createAndProcessPayout', () => {
    it('blocks with NO_BANK_DETAILS when the operator has no recipient code', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: null, businessName: 'Swift Towing',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: { rescueRequestId: 'req-1', operatorId: 'op-1', amount: 250000 },
      });
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', blockReason: 'NO_BANK_DETAILS', failureReason: null },
      });
      expect(paystack.checkBalance).not.toHaveBeenCalled();
    });

    it('blocks with INSUFFICIENT_BALANCE when the platform balance cannot cover the amount', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(100000);

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', blockReason: 'INSUFFICIENT_BALANCE', failureReason: null },
      });
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('initiates a transfer and sets PROCESSING on success', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({ transferCode: 'TRF_test123', status: 'pending' });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paystack.initiateTransfer).toHaveBeenCalledWith({
        recipientCode: 'RCP_existing', amount: 250000, reference: 'PAYOUT_test123', reason: 'Job payout — req-1',
      });
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PROCESSING', blockReason: null, paystackTransferCode: 'TRF_test123' },
      });
    });

    it('marks FAILED when the transfer API call throws', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockRejectedValue(new Error('Paystack 500'));

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'FAILED', blockReason: null, failureReason: 'Paystack 500' },
      });
    });

    it('never throws back to the caller even on an unexpected error', async () => {
      prisma.payout.create.mockRejectedValue(new Error('DB unavailable'));

      await expect(service.createAndProcessPayout('req-1', 'op-1', 250000)).resolves.not.toThrow();
    });
  });

  describe('confirmTransferOutcome', () => {
    it('sets SUCCESS and completedAt when found', async () => {
      prisma.payout.update.mockResolvedValue({});

      await service.confirmTransferOutcome('TRF_test123', 'SUCCESS');

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { paystackTransferCode: 'TRF_test123' },
        data: { status: 'SUCCESS', completedAt: expect.any(Date) },
      });
    });

    it('sets FAILED with the given reason when found', async () => {
      prisma.payout.update.mockResolvedValue({});

      await service.confirmTransferOutcome('TRF_test123', 'FAILED', 'Invalid account');

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { paystackTransferCode: 'TRF_test123' },
        data: { status: 'FAILED', failureReason: 'Invalid account' },
      });
    });

    it('does not throw when no matching payout is found', async () => {
      prisma.payout.update.mockRejectedValue(new Error('Record to update not found'));

      await expect(service.confirmTransferOutcome('TRF_unknown', 'SUCCESS')).resolves.not.toThrow();
    });
  });
});
