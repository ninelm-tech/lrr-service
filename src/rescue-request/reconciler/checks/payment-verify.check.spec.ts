import { Test, TestingModule } from '@nestjs/testing';
import { PaymentVerifyCheck } from './payment-verify.check';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaystackService } from '../../../integrations/paystack/paystack.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { PaymentLedgerService } from '../../../payment/payment-ledger.service';
import { PaymentEventsService } from '../../payment-events.service';
import { PayoutService } from '../../../payout/payout.service';
import { PaystackCustomerService } from '../../../payment/paystack-customer.service';

describe('PaymentVerifyCheck — SUBMITTED collection still pending at Paystack', () => {
  let check: PaymentVerifyCheck;
  let prisma: {
    payment: { findMany: jest.Mock; findUnique: jest.Mock };
    rescueRequest: { findUnique: jest.Mock };
  };
  let paystackService: { verifyTransaction: jest.Mock };
  let twilioService: { sendWhatsAppMessage: jest.Mock };
  let paymentLedger: { referenceFor: jest.Mock; backOff: jest.Mock };

  const now = new Date('2026-09-16T12:00:00Z');

  // 'abandoned' maps to PaymentStatus.SUBMITTED for a collection — see
  // mapTransactionStatus: not terminal, the customer hasn't paid yet.
  const stillPendingAtPaystack = {
    outcome: 'ok',
    data: { status: 'abandoned', id: 1, amount: 500000 },
  };

  const setup = async (payment: {
    id: string;
    type: 'DEPOSIT' | 'BALANCE';
  }) => {
    prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: payment.id, status: 'SUBMITTED' }]),
        findUnique: jest.fn().mockResolvedValue({
          id: payment.id,
          type: payment.type,
          status: 'SUBMITTED',
          checkoutUrl: 'https://checkout.paystack.com/abc123',
          rescueRequestId: 'req-1',
        }),
      },
      rescueRequest: {
        // Same mock answers both call sites (the status check and
        // resendCheckoutLink's own lookup) — each only reads the field it
        // needs, so one shape can satisfy both.
        findUnique: jest.fn().mockResolvedValue({
          status: 'WAITING_FOR_DEPOSIT',
          customer: { phoneNumber: '+15551234567' },
        }),
      },
    };
    paystackService = {
      verifyTransaction: jest.fn().mockResolvedValue(stillPendingAtPaystack),
    };
    twilioService = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
    };
    paymentLedger = {
      referenceFor: jest.fn().mockReturnValue(`DEP_${payment.id}`),
      backOff: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentVerifyCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystackService },
        { provide: TwilioService, useValue: twilioService },
        { provide: PaymentLedgerService, useValue: paymentLedger },
        { provide: PaymentEventsService, useValue: {} },
        { provide: PayoutService, useValue: {} },
        { provide: PaystackCustomerService, useValue: {} },
      ],
    }).compile();

    check = module.get(PaymentVerifyCheck);
  };

  it('never resends a DEPOSIT link while its request is still WAITING_FOR_DEPOSIT — deposit-reminder.check.ts is its sole reminder', async () => {
    await setup({ id: 'pay-1', type: 'DEPOSIT' });
    prisma.rescueRequest.findUnique.mockResolvedValue({
      status: 'WAITING_FOR_DEPOSIT',
      customer: { phoneNumber: '+15551234567' },
    });

    await check.run(now);

    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    // Doesn't even need to look the request up — DEPOSIT skips this
    // unconditionally, regardless of status.
    expect(prisma.rescueRequest.findUnique).not.toHaveBeenCalled();
    expect(paymentLedger.backOff).toHaveBeenCalledWith('pay-1', now);
  });

  it('never resends a DEPOSIT link once its request is CANCELLED either', async () => {
    await setup({ id: 'pay-2', type: 'DEPOSIT' });
    prisma.rescueRequest.findUnique.mockResolvedValue({
      status: 'CANCELLED',
      customer: { phoneNumber: '+15551234567' },
    });

    await check.run(now);

    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    // Still polled — a late payment (webhook or a future check) must still
    // be catchable and flagged for refund, this only stops the nag.
    expect(paymentLedger.backOff).toHaveBeenCalledWith('pay-2', now);
  });

  it('does not resend a BALANCE link once its (already COMPLETED) request is CANCELLED', async () => {
    // cancel() has no status guard — an admin can cancel a COMPLETED
    // request, which is exactly where a pending BALANCE payment lives.
    await setup({ id: 'pay-3', type: 'BALANCE' });
    prisma.rescueRequest.findUnique.mockResolvedValue({
      status: 'CANCELLED',
      customer: { phoneNumber: '+15551234567' },
    });

    await check.run(now);

    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(paymentLedger.backOff).toHaveBeenCalledWith('pay-3', now);
  });

  it('still resends a BALANCE link on its normal COMPLETED-but-unpaid request — it has no other reminder', async () => {
    await setup({ id: 'pay-4', type: 'BALANCE' });
    prisma.rescueRequest.findUnique.mockResolvedValue({
      status: 'COMPLETED',
      customer: { phoneNumber: '+15551234567' },
    });

    await check.run(now);

    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      'whatsapp:+15551234567',
      expect.stringContaining('still waiting'),
    );
    expect(paymentLedger.backOff).toHaveBeenCalledWith('pay-4', now);
  });
});

describe('PaymentVerifyCheck — PENDING deposit recovery', () => {
  it('rejects a recovered deposit before Paystack when no operator is assigned', async () => {
    const now = new Date('2026-09-16T12:00:00Z');
    const prisma = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'pay-1', status: 'PENDING' }]),
        findUnique: jest.fn().mockResolvedValue({
          id: 'pay-1',
          type: 'DEPOSIT',
          status: 'PENDING',
          amount: 500000,
          rescueRequestId: 'req-1',
        }),
      },
      rescueRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'req-1',
          customerId: 'cust-1',
          assignedOperatorId: null,
          customer: { phoneNumber: '+15551234567' },
        }),
      },
    };
    const paystackService = { initializePayment: jest.fn() };
    const paymentLedger = {
      claimForSubmission: jest.fn().mockResolvedValue(true),
      recordRejection: jest.fn().mockResolvedValue(undefined),
      referenceFor: jest.fn(),
    };
    const paystackCustomerService = { customerFor: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentVerifyCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystackService },
        {
          provide: TwilioService,
          useValue: { sendWhatsAppMessage: jest.fn() },
        },
        { provide: PaymentLedgerService, useValue: paymentLedger },
        { provide: PaymentEventsService, useValue: {} },
        { provide: PayoutService, useValue: {} },
        { provide: PaystackCustomerService, useValue: paystackCustomerService },
      ],
    }).compile();

    await module.get(PaymentVerifyCheck).run(now);

    expect(paymentLedger.claimForSubmission).toHaveBeenCalledWith('pay-1', now);
    expect(paymentLedger.recordRejection).toHaveBeenCalledWith(
      'pay-1',
      'Cannot initiate deposit before an operator is assigned',
    );
    expect(paystackCustomerService.customerFor).not.toHaveBeenCalled();
    expect(paystackService.initializePayment).not.toHaveBeenCalled();
  });
});
