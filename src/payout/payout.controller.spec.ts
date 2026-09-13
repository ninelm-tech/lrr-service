import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PayoutController } from './payout.controller';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutService } from './payout.service';

describe('PayoutController', () => {
  let controller: PayoutController;
  let prisma: { payment: { findMany: jest.Mock } };
  let payoutService: { retryPayout: jest.Mock };

  beforeEach(async () => {
    prisma = { payment: { findMany: jest.fn() } };
    payoutService = { retryPayout: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayoutController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: PayoutService, useValue: payoutService },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get<PayoutController>(PayoutController);
  });

  describe('list', () => {
    it('lists PAYOUT payments joined with operator and rescue request info, optionally filtered by status', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'pay-1',
          type: 'PAYOUT',
          status: 'FAILED',
          operator: { businessName: 'Swift Towing' },
          rescueRequest: { id: 'req-1' },
        },
      ]);

      const result = await controller.list('FAILED');

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { type: 'PAYOUT', status: 'FAILED' },
        include: {
          operator: { select: { businessName: true } },
          rescueRequest: {
            select: { id: true, disputed: true, disputeResolvedAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result.data).toHaveLength(1);
    });

    it('omits the status filter when none is given, keeping only the PAYOUT type filter', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await controller.list(undefined);

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { type: 'PAYOUT' } }),
      );
    });
  });

  describe('retry', () => {
    it('delegates to PayoutService.retryPayout', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUBMITTED',
        blockReason: null,
        failureReason: null,
      });

      await controller.retry('pay-1');

      expect(payoutService.retryPayout).toHaveBeenCalledWith('pay-1');
    });

    it('reports a transfer actually being initiated', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUBMITTED',
        blockReason: null,
        failureReason: null,
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('Transfer initiated');
    });

    it('reports completion for a SUCCEEDED payment', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUCCEEDED',
        blockReason: null,
        failureReason: null,
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toBe('Payout completed.');
    });

    it('does NOT claim success when the retry immediately re-blocked on missing bank details', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'NO_BANK_DETAILS',
        failureReason: null,
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('no bank details on file');
      expect(result.message).not.toContain('initiated');
    });

    it('reports a balance block distinctly from a bank-details block', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'INSUFFICIENT_BALANCE',
        failureReason: null,
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('Paystack balance is too low');
    });

    it('reports an otp block distinctly from the two blocks caused by us', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'AWAITING_OTP',
        failureReason: null,
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('awaiting an OTP');
    });

    it('surfaces the failure reason when the transfer attempt failed outright', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'FAILED',
        blockReason: null,
        failureReason: 'Recipient account invalid',
      });

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('Recipient account invalid');
    });

    it('reports a null payment as unreadable rather than throwing', async () => {
      payoutService.retryPayout.mockResolvedValue(null);

      const result = await controller.retry('pay-1');

      expect(result.message).toContain('could not be read');
    });
  });
});
