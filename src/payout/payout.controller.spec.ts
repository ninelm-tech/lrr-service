import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PayoutController } from './payout.controller';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutService } from './payout.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { createAuditLogServiceMock } from '../audit-log/testing/audit-log.mock';

const req = { user: { userId: 'admin-1' } } as never;

describe('PayoutController', () => {
  let controller: PayoutController;
  let prisma: { payment: { findMany: jest.Mock } };
  let payoutService: { retryPayout: jest.Mock };
  let auditLogService: ReturnType<typeof createAuditLogServiceMock>;

  beforeEach(async () => {
    // Default: no succeeded rows anywhere, so the second (succeeded-lookup)
    // findMany call returns empty unless a test overrides it.
    prisma = { payment: { findMany: jest.fn().mockResolvedValue([]) } };
    payoutService = { retryPayout: jest.fn() };
    auditLogService = createAuditLogServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayoutController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: PayoutService, useValue: payoutService },
        { provide: JwtService, useValue: {} },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    controller = module.get<PayoutController>(PayoutController);
  });

  describe('list', () => {
    it('lists PAYOUT payments joined with operator and rescue request info, optionally filtered by status', async () => {
      prisma.payment.findMany
        .mockResolvedValueOnce([
          {
            id: 'pay-1',
            type: 'PAYOUT',
            status: 'FAILED',
            rescueRequestId: 'req-1',
            operator: { businessName: 'Swift Towing' },
            rescueRequest: { id: 'req-1' },
          },
        ])
        .mockResolvedValueOnce([]); // succeeded-lookup: none

      const result = await controller.list('FAILED');

      expect(prisma.payment.findMany).toHaveBeenNthCalledWith(1, {
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
      prisma.payment.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await controller.list(undefined);

      expect(prisma.payment.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { type: 'PAYOUT' } }),
      );
    });

    it('skips the succeeded-lookup query entirely for an empty page — never scans the whole table', async () => {
      prisma.payment.findMany.mockResolvedValueOnce([]);

      const result = await controller.list('FAILED');

      expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
      expect(result.data).toEqual([]);
    });

    it('scopes the succeeded-lookup to just the jobs on this page, not every succeeded payout ever', async () => {
      prisma.payment.findMany
        .mockResolvedValueOnce([
          {
            id: 'pay-1',
            type: 'PAYOUT',
            status: 'FAILED',
            rescueRequestId: 'req-1',
            operator: { businessName: 'Swift Towing' },
            rescueRequest: { id: 'req-1' },
          },
        ])
        .mockResolvedValueOnce([{ rescueRequestId: 'req-1' }]);

      await controller.list('FAILED');

      expect(prisma.payment.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          type: 'PAYOUT',
          status: 'SUCCEEDED',
          rescueRequestId: { in: ['req-1'] },
        },
        select: { rescueRequestId: true },
      });
    });

    it('flags a row as alreadySucceeded when a DIFFERENT row for the same job has SUCCEEDED — even though this row is FAILED', async () => {
      // The succeeded-lookup is unfiltered by `status`, so it still finds
      // the sibling even though the visible list here is filtered to FAILED.
      prisma.payment.findMany
        .mockResolvedValueOnce([
          {
            id: 'pay-1',
            type: 'PAYOUT',
            status: 'FAILED',
            rescueRequestId: 'req-1',
            operator: { businessName: 'Swift Towing' },
            rescueRequest: { id: 'req-1' },
          },
        ])
        .mockResolvedValueOnce([{ rescueRequestId: 'req-1' }]);

      const result = await controller.list('FAILED');

      expect(result.data[0]).toMatchObject({
        id: 'pay-1',
        alreadySucceeded: true,
      });
    });

    it('does not flag a row when no sibling for that job has succeeded', async () => {
      prisma.payment.findMany
        .mockResolvedValueOnce([
          {
            id: 'pay-1',
            type: 'PAYOUT',
            status: 'FAILED',
            rescueRequestId: 'req-1',
            operator: { businessName: 'Swift Towing' },
            rescueRequest: { id: 'req-1' },
          },
        ])
        .mockResolvedValueOnce([{ rescueRequestId: 'some-other-req' }]);

      const result = await controller.list('FAILED');

      expect(result.data[0]).toMatchObject({
        id: 'pay-1',
        alreadySucceeded: false,
      });
    });
  });

  describe('retry', () => {
    it('delegates to PayoutService.retryPayout', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUBMITTED',
        blockReason: null,
        failureReason: null,
      });

      await controller.retry(req, 'pay-1');

      expect(payoutService.retryPayout).toHaveBeenCalledWith('pay-1');
    });

    it('reports a transfer actually being initiated', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUBMITTED',
        blockReason: null,
        failureReason: null,
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('Transfer initiated');
    });

    it('reports completion for a SUCCEEDED payment', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'SUCCEEDED',
        blockReason: null,
        failureReason: null,
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toBe('Payout completed.');
    });

    it('does NOT claim success when the retry immediately re-blocked on missing bank details', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'NO_BANK_DETAILS',
        failureReason: null,
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('no bank details on file');
      expect(result.message).not.toContain('initiated');
    });

    it('reports a balance block distinctly from a bank-details block', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'INSUFFICIENT_BALANCE',
        failureReason: null,
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('Paystack balance is too low');
    });

    it('reports an otp block distinctly from the two blocks caused by us', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'BLOCKED',
        blockReason: 'AWAITING_OTP',
        failureReason: null,
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('awaiting an OTP');
    });

    it('surfaces the failure reason when the transfer attempt failed outright', async () => {
      payoutService.retryPayout.mockResolvedValue({
        status: 'FAILED',
        blockReason: null,
        failureReason: 'Recipient account invalid',
      });

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('Recipient account invalid');
    });

    it('reports a null payment as unreadable rather than throwing', async () => {
      payoutService.retryPayout.mockResolvedValue(null);

      const result = await controller.retry(req, 'pay-1');

      expect(result.message).toContain('could not be read');
    });

    it('records an audit log entry with the acting admin and the outcome', async () => {
      payoutService.retryPayout.mockResolvedValue({
        id: 'pay-2',
        status: 'SUBMITTED',
        blockReason: null,
        failureReason: null,
      });

      await controller.retry(req, 'pay-1');

      expect(auditLogService.record).toHaveBeenCalledWith({
        category: 'payout_retried',
        message: 'Retried payout pay-1',
        details: {
          paymentId: 'pay-1',
          resultStatus: 'SUBMITTED',
          resultPaymentId: 'pay-2',
        },
        actorId: 'admin-1',
      });
    });

    it('records a null result in the audit log when the payment could not be read', async () => {
      payoutService.retryPayout.mockResolvedValue(null);

      await controller.retry(req, 'pay-1');

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            paymentId: 'pay-1',
            resultStatus: null,
            resultPaymentId: null,
          },
        }),
      );
    });
  });
});
