import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { PaymentService } from './payment.service';
import { PaymentEventsService } from '../rescue-request/payment-events.service';
import { PayoutService } from '../payout/payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from './payment-ledger.service';
import {
  createPaymentLedgerMock,
  PaymentLedgerMock,
} from './testing/payment-ledger.mock';
import { AuditLogService } from '../audit-log/audit-log.service';
import { createAuditLogServiceMock } from '../audit-log/testing/audit-log.mock';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

describe('PaymentService', () => {
  let service: PaymentService;
  let paymentEventsService: {
    confirmDeposit: jest.Mock;
    confirmBalance: jest.Mock;
  };
  let payoutService: { notifyPayoutOutcome: jest.Mock };
  let paymentLedger: PaymentLedgerMock;
  let auditLogService: ReturnType<typeof createAuditLogServiceMock>;
  let prisma: {
    payment: { findUnique: jest.Mock };
    rescueRequest: { update: jest.Mock };
  };

  beforeEach(async () => {
    (Sentry.captureMessage as jest.Mock).mockClear();
    (Sentry.captureException as jest.Mock).mockClear();
    paymentEventsService = {
      confirmDeposit: jest.fn(),
      confirmBalance: jest.fn(),
    };
    payoutService = { notifyPayoutOutcome: jest.fn() };
    paymentLedger = createPaymentLedgerMock();
    auditLogService = createAuditLogServiceMock();
    prisma = {
      // No matching row by default: the legacy-reference case, where the
      // business side effects must still run.
      payment: { findUnique: jest.fn().mockResolvedValue(null) },
      rescueRequest: { update: jest.fn().mockResolvedValue({}) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PaymentEventsService, useValue: paymentEventsService },
        { provide: PayoutService, useValue: payoutService },
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentLedgerService, useValue: paymentLedger },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a signature computed over the exact raw bytes', () => {
      const rawBody = Buffer.from(
        JSON.stringify({
          event: 'charge.success',
          data: { reference: 'DEP_1' },
        }),
      );
      const validSignature = crypto
        .createHmac('sha512', '')
        .update(rawBody)
        .digest('hex');

      expect(service.verifyWebhookSignature(rawBody, validSignature)).toBe(
        true,
      );
    });

    it('rejects a signature computed over a re-serialized (not raw) body', () => {
      // Re-stringifying a parsed object isn't guaranteed to reproduce the
      // original bytes — this is exactly the bug that made real Paystack
      // webhooks fail signature verification.
      const original = {
        data: { reference: 'DEP_1' },
        event: 'charge.success',
      };
      const rawBody = Buffer.from(JSON.stringify(original));
      const validSignature = crypto
        .createHmac('sha512', '')
        .update(rawBody)
        .digest('hex');

      const reserialized = JSON.stringify(
        JSON.parse(rawBody.toString()),
        Object.keys(original).reverse(),
      );
      expect(service.verifyWebhookSignature(reserialized, validSignature)).toBe(
        false,
      );
    });

    it('rejects a mismatched signature', () => {
      expect(
        service.verifyWebhookSignature(
          Buffer.from('{}'),
          'not-a-real-signature',
        ),
      ).toBe(false);
    });
  });

  describe('handlePaystackWebhook — transfer events', () => {
    const PAYOUT_PAYMENT = {
      id: 'pay-1',
      type: 'PAYOUT',
      rescueRequestId: 'req-1',
      operatorId: 'op-1',
      status: 'SUBMITTED',
      amount: 250000,
    };

    beforeEach(() => {
      prisma.payment.findUnique.mockResolvedValue(PAYOUT_PAYMENT);
    });

    it('notifies the operator on transfer.success — the only place that does', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.success',
        data: {
          reference: 'payout_pay-1',
          transfer_code: 'TRF_test123',
          reason: 'Job payout',
        },
      });

      expect(payoutService.notifyPayoutOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pay-1', status: 'SUCCEEDED' }),
      );
    });

    it('does not notify on transfer.failed — matches the pre-existing behaviour', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.failed',
        data: {
          reference: 'payout_pay-1',
          transfer_code: 'TRF_test123',
          reason: 'Invalid account number',
        },
      });

      expect(payoutService.notifyPayoutOutcome).not.toHaveBeenCalled();
    });

    it('does not notify on transfer.reversed', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.reversed',
        data: {
          reference: 'payout_pay-1',
          transfer_code: 'TRF_test123',
          reason: 'Reversed by bank',
        },
      });

      expect(payoutService.notifyPayoutOutcome).not.toHaveBeenCalled();
    });

    it('does not notify when this call loses the race — claimTerminal returns false', async () => {
      paymentLedger.claimTerminal.mockResolvedValue(false);

      await service.handlePaystackWebhook({
        event: 'transfer.success',
        data: { reference: 'payout_pay-1', transfer_code: 'TRF_test123' },
      });

      expect(payoutService.notifyPayoutOutcome).not.toHaveBeenCalled();
      // Losing a claim race is the normal case (a webhook and verification
      // arriving for the same row) — never worth an alert.
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('alerts via Sentry when a transfer reference matches no Payment row at all', async () => {
      // A reference with none of our prefixes (DEP_/BAL_/payout_) is exactly
      // what Paystack's own auto-generated reference looks like when a
      // transfer was created directly in their dashboard rather than
      // through our API.
      await service.handlePaystackWebhook({
        event: 'transfer.success',
        data: {
          reference: '0wx9yba55hqq595kfncp',
          transfer_code: 'TRF_dashboard',
          amount: 700000,
          reason: 'Manual payout',
        },
      });

      expect(payoutService.notifyPayoutOutcome).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized transfer webhook'),
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({
            event: 'transfer.success',
            reference: '0wx9yba55hqq595kfncp',
            transferCode: 'TRF_dashboard',
            amount: 700000,
          }),
        }),
      );
      // Both fire together — Sentry for paging, this for a durable,
      // queryable record that doesn't age out.
      expect(auditLogService.record).toHaveBeenCalledWith({
        category: 'unrecognized_transfer_webhook',
        message: 'Unrecognized transfer webhook — no matching Payment row',
        details: {
          event: 'transfer.success',
          reference: '0wx9yba55hqq595kfncp',
          transferCode: 'TRF_dashboard',
          amount: 700000,
          reason: 'Manual payout',
        },
      });
    });

    it('does not write an audit entry when this call loses the race — claimTerminal returns false', async () => {
      paymentLedger.claimTerminal.mockResolvedValue(false);

      await service.handlePaystackWebhook({
        event: 'transfer.success',
        data: { reference: 'payout_pay-1', transfer_code: 'TRF_test123' },
      });

      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('handlePaystackWebhook — charge.success with no matching row', () => {
    // Uses the outer beforeEach's default (findUnique resolves null) rather
    // than the transfer describe's override — this is the actual
    // legacy-reference / genuinely-unmatched case for a collection.
    it('does not alert — collections keep their existing quiet behaviour', async () => {
      await service.handlePaystackWebhook({
        event: 'charge.success',
        data: { reference: 'DEP_unknown-id', id: 123 },
      });

      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });
});
