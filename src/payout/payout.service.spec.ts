import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: {
    payout: { create: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
    operator: { findUnique: jest.Mock };
  };
  let paystack: {
    checkBalance: jest.Mock;
    initiateTransfer: jest.Mock;
    generateReference: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      payout: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
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

  describe('retryPayout', () => {
    const retryablePayout = (status: string) => ({
      id: 'payout-1', operatorId: 'op-1', amount: 250000, rescueRequestId: 'req-1', status,
    });

    it('throws NotFoundException for an unknown payout', async () => {
      prisma.payout.findUnique.mockResolvedValue(null);

      await expect(service.retryPayout('nope')).rejects.toThrow('Payout not found');
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it.each(['SUCCESS', 'PROCESSING'])(
      'refuses to retry a %s payout — a second transfer would pay the operator twice',
      async (status) => {
        prisma.payout.findUnique.mockResolvedValue(retryablePayout(status));
        // No row matches the PENDING/FAILED claim condition.
        prisma.payout.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.retryPayout('payout-1')).rejects.toThrow(
          `Only blocked or failed payouts can be retried — this one is ${status}.`,
        );
        expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      },
    );

    it.each(['PENDING', 'FAILED'])('retries a %s payout', async (status) => {
      prisma.payout.findUnique.mockResolvedValue(retryablePayout(status));
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', paystackRecipientCode: 'RCP_x' });
      paystack.checkBalance.mockResolvedValue(1_000_000);
      paystack.initiateTransfer.mockResolvedValue({ transferCode: 'TRF_retry' });

      await service.retryPayout('payout-1');

      expect(prisma.payout.updateMany).toHaveBeenCalledWith({
        where: { id: 'payout-1', status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PROCESSING' },
      });
      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
    });

    it('returns the re-blocked state when the operator still has no bank details, rather than reporting success', async () => {
      prisma.payout.findUnique
        .mockResolvedValueOnce(retryablePayout('PENDING'))   // initial read
        .mockResolvedValueOnce({                              // state after the attempt
          ...retryablePayout('PENDING'), blockReason: 'NO_BANK_DETAILS',
        });
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', paystackRecipientCode: null });

      const result = await service.retryPayout('payout-1');

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', blockReason: 'NO_BANK_DETAILS', failureReason: null },
      });
      expect(result).toMatchObject({ status: 'PENDING', blockReason: 'NO_BANK_DETAILS' });
    });

    it('loses the race safely — the admin whose claim matches no row gets rejected, not a second transfer', async () => {
      // Status still reads PENDING (stale read), but a concurrent retry has
      // already claimed the row, so the conditional update matches nothing.
      prisma.payout.findUnique.mockResolvedValue(retryablePayout('PENDING'));
      prisma.payout.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.retryPayout('payout-1')).rejects.toThrow('Only blocked or failed payouts');
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
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
