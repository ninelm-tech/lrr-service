import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import {
  createPaymentLedgerMock,
  PaymentLedgerMock,
} from '../payment/testing/payment-ledger.mock';

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: {
    operator: { findUnique: jest.Mock };
    payment: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let paystack: {
    checkBalance: jest.Mock;
    initiateTransfer: jest.Mock;
  };
  let paymentLedger: PaymentLedgerMock;
  let twilio: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
  };
  const originalTemplateSids = {
    sent: process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID,
    bank: process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID,
  };

  afterEach(() => {
    for (const [key, value] of [
      ['TWILIO_PAYOUT_SENT_TEMPLATE_SID', originalTemplateSids.sent],
      ['TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID', originalTemplateSids.bank],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    prisma = {
      operator: { findUnique: jest.fn() },
      payment: {
        // No in-flight payout row by default: the common case is a first
        // attempt, which inserts rather than resuming.
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    paystack = {
      checkBalance: jest.fn(),
      initiateTransfer: jest.fn(),
    };
    paymentLedger = createPaymentLedgerMock();
    twilio = {
      sendWhatsAppMessage: jest.fn(),
      sendWhatsAppTemplateMessage: jest.fn(),
    };
    delete process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID;
    delete process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystack },
        { provide: TwilioService, useValue: twilio },
        { provide: PaymentLedgerService, useValue: paymentLedger },
      ],
    }).compile();

    service = module.get<PayoutService>(PayoutService);
  });

  describe('createAndProcessPayout', () => {
    it('blocks with NO_BANK_DETAILS when the operator has no recipient code, and tells the operator', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: null,
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        type: 'PAYOUT',
        amount: 250000,
        operatorId: 'op-1',
      });
      expect(paymentLedger.recordBlocked).toHaveBeenCalledWith(
        'pay-1',
        'NO_BANK_DETAILS',
      );
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        expect.stringContaining("don't have your bank details"),
      );
      expect(paystack.checkBalance).not.toHaveBeenCalled();
    });

    it('does not re-notify when the payout was already blocked for the same reason', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: null,
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      // The "before" read blockPayment uses to detect a repeat.
      prisma.payment.findFirst.mockResolvedValue({
        id: 'pay-existing',
        status: 'BLOCKED',
        blockReason: 'NO_BANK_DETAILS',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      // Still recorded — the row is unblocked and re-blocked, just silently.
      expect(paymentLedger.recordBlocked).toHaveBeenCalledWith(
        'pay-existing',
        'NO_BANK_DETAILS',
      );
    });

    it('sends the bank-details notice via the approved template when its SID is configured', async () => {
      process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID = 'HXbank123';
      process.env.FRONTEND_URL = 'https://portal.example.com';
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: null,
        phoneNumber: '+2349012345678',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        'HXbank123',
        {
          '1': expect.any(String),
          '2': '2,500',
          '3': 'https://portal.example.com/settings',
        },
      );
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a failed notification never breaks the payout flow', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: null,
        phoneNumber: '+2349012345678',
      });
      twilio.sendWhatsAppMessage.mockRejectedValue(
        new Error('63016: outside messaging window'),
      );

      await expect(
        service.createAndProcessPayout('req-1', 'op-1', 250000),
      ).resolves.not.toThrow();
    });

    it('blocks with INSUFFICIENT_BALANCE when the platform balance cannot cover the amount, without notifying', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(100000);

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.recordBlocked).toHaveBeenCalledWith(
        'pay-1',
        'INSUFFICIENT_BALANCE',
      );
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      // Never notified for this reason — it's staff's problem, not theirs.
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    });

    it('initiates a transfer with the ledger row id as the reference', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_test123', status: 'pending' },
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      // The reference is the ledger row's id, so verification and the
      // webhook can both find the payment it belongs to.
      expect(paystack.initiateTransfer).toHaveBeenCalledWith({
        recipientCode: 'RCP_existing',
        amount: 250000,
        reference: 'payout_pay-1',
        reason: 'Job payout — req-1',
      });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { providerRef: 'trf:TRF_test123' },
      });
      // `pending` is not success — stays SUBMITTED, nothing claimed.
      expect(paymentLedger.claimTerminal).not.toHaveBeenCalled();
    });

    it('does NOT fail the payment when the transfer result is ambiguous', async () => {
      // A 5xx or a dropped connection may have moved money, so FAILED here
      // would make a fresh reference legal — the actual double-pay.
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'Paystack 500',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.recordRejection).not.toHaveBeenCalled();
      expect(paymentLedger.claimTerminal).not.toHaveBeenCalled();
    });

    it('treats a duplicate reference as evidence the original landed, not a rejection', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'duplicate_reference',
        message: 'Transfer reference has already been used',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.recordRejection).not.toHaveBeenCalled();
    });

    it('fails the payment on a definitive, non-duplicate rejection', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'invalid_recipient',
        message: 'Recipient is invalid',
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.recordRejection).toHaveBeenCalledWith(
        'pay-1',
        'Recipient is invalid',
      );
    });

    it('blocks on otp rather than leaving the transfer stranded SUBMITTED', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_test123', status: 'otp' },
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.recordBlocked).toHaveBeenCalledWith(
        'pay-1',
        'AWAITING_OTP',
      );
    });

    it('claims abandoned as FAILED — the live bug', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_test123', status: 'abandoned' },
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.claimTerminal).toHaveBeenCalledWith(
        'pay-1',
        expect.objectContaining({ status: 'FAILED' }),
      );
    });

    it('never claims SUCCEEDED from the initiate response, even when it says success', async () => {
      // SUCCEEDED comes only from a webhook or verification.
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_existing',
        businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_test123', status: 'success' },
      });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paymentLedger.claimTerminal).not.toHaveBeenCalled();
    });

    it('never throws back to the caller even on an unexpected error', async () => {
      prisma.operator.findUnique.mockRejectedValue(new Error('DB unavailable'));

      await expect(
        service.createAndProcessPayout('req-1', 'op-1', 250000),
      ).resolves.not.toThrow();
    });
  });

  describe('retryPayout', () => {
    const payoutPayment = (status: string, overrides = {}) => ({
      id: 'pay-1',
      type: 'PAYOUT',
      operatorId: 'op-1',
      amount: 250000,
      rescueRequestId: 'req-1',
      status,
      blockReason: null,
      ...overrides,
    });

    it('throws NotFoundException for an unknown payment id', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.retryPayout('nope')).rejects.toThrow(
        'Payout not found',
      );
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the payment is not a PAYOUT', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        payoutPayment('FAILED', { type: 'DEPOSIT' }),
      );

      await expect(service.retryPayout('pay-1')).rejects.toThrow(
        'Payout not found',
      );
    });

    it.each(['SUCCEEDED', 'SUBMITTED'])(
      'refuses to retry a %s payout — a second transfer would pay the operator twice',
      async (status) => {
        prisma.payment.findUnique.mockResolvedValue(payoutPayment(status));

        await expect(service.retryPayout('pay-1')).rejects.toThrow(
          `Only blocked or failed payouts can be retried — this one is ${status}.`,
        );
        expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      },
    );

    it('retries a FAILED payout by inserting a fresh sibling row', async () => {
      prisma.payment.findUnique.mockResolvedValue(payoutPayment('FAILED'));
      // No existing in-flight row — FAILED isn't one, so claimPayoutPayment
      // creates a new attempt rather than resuming.
      prisma.payment.findFirst.mockResolvedValueOnce(null);
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_x',
      });
      paystack.checkBalance.mockResolvedValue(1_000_000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_retry', status: 'pending' },
      });
      // The reload after retrying.
      prisma.payment.findFirst.mockResolvedValueOnce(
        payoutPayment('SUBMITTED'),
      );

      await service.retryPayout('pay-1');

      expect(paymentLedger.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        type: 'PAYOUT',
        amount: 250000,
        operatorId: 'op-1',
      });
      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
    });

    it('retries a BLOCKED payout by resuming the same row', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        payoutPayment('BLOCKED', { blockReason: 'NO_BANK_DETAILS' }),
      );
      prisma.payment.findFirst.mockResolvedValue(
        payoutPayment('BLOCKED', { blockReason: 'NO_BANK_DETAILS' }),
      );
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_x',
      });
      paystack.checkBalance.mockResolvedValue(1_000_000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_retry', status: 'pending' },
      });

      await service.retryPayout('pay-1');

      expect(paymentLedger.unblock).toHaveBeenCalledWith(
        'pay-1',
        expect.any(Date),
      );
      expect(paymentLedger.create).not.toHaveBeenCalled();
    });

    it('returns the LATEST attempt for the request, not the stale row passed in', async () => {
      prisma.payment.findUnique.mockResolvedValue(payoutPayment('FAILED'));
      prisma.payment.findFirst
        .mockResolvedValueOnce(null) // claimPayoutPayment: no existing in-flight row
        .mockResolvedValueOnce(payoutPayment('SUBMITTED', { id: 'pay-2' })); // reload
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        paystackRecipientCode: 'RCP_x',
      });
      paystack.checkBalance.mockResolvedValue(1_000_000);
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { transfer_code: 'TRF_retry', status: 'pending' },
      });

      const result = await service.retryPayout('pay-1');

      expect(result).toMatchObject({ id: 'pay-2', status: 'SUBMITTED' });
    });

    it('throws BadRequestException when the payment has no operatorId', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        payoutPayment('FAILED', { operatorId: null }),
      );

      await expect(service.retryPayout('pay-1')).rejects.toThrow(
        'Payout has no operator on record',
      );
    });
  });

  describe('notifyPayoutOutcome', () => {
    const succeededPayment = (overrides = {}) =>
      ({
        id: 'pay-1',
        type: 'PAYOUT',
        status: 'SUCCEEDED',
        operatorId: 'op-1',
        amount: 250000,
        rescueRequestId: 'req-1',
        ...overrides,
      }) as never;

    it('tells the operator they have been paid', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        phoneNumber: '+2349012345678',
      });

      await service.notifyPayoutOutcome(succeededPayment());

      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        expect.stringContaining('₦2,500'),
      );
    });

    it('sends the paid notice via the approved template when its SID is configured', async () => {
      process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID = 'HXpaid123';
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        phoneNumber: '+2349012345678',
      });

      await service.notifyPayoutOutcome(succeededPayment());

      expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        'HXpaid123',
        { '1': expect.any(String), '2': '2,500' },
      );
    });

    it('does nothing for a non-SUCCEEDED payment — FAILED/REVERSED were never notified either', async () => {
      await service.notifyPayoutOutcome(succeededPayment({ status: 'FAILED' }));

      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('does nothing when the payment has no operatorId', async () => {
      await service.notifyPayoutOutcome(succeededPayment({ operatorId: null }));

      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
    });

    it('a failed notification does not throw', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        phoneNumber: '+2349012345678',
      });
      twilio.sendWhatsAppMessage.mockRejectedValue(new Error('63016'));

      await expect(
        service.notifyPayoutOutcome(succeededPayment()),
      ).resolves.not.toThrow();
    });
  });
});
