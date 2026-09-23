import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { Payment } from '@prisma/client';
import { PaymentEventsService } from './payment-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { createPaymentLedgerMock } from '../payment/testing/payment-ledger.mock';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { createPaystackCustomerServiceMock } from '../payment/testing/paystack-customer.mock';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

/** The two fields confirmDeposit/confirmBalance actually read off Payment. */
const paymentFor = (rescueRequestId: string, id = 'pay-1'): Payment =>
  ({ id, rescueRequestId }) as Payment;

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
  logger: { info: jest.fn() },
}));

describe('PaymentEventsService', () => {
  let service: PaymentEventsService;
  let prisma: {
    rescueRequest: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    dispatchOffer: { updateMany: jest.Mock };
    payment: { update: jest.Mock };
  };
  let payoutServiceMock: { createAndProcessPayout: jest.Mock };
  let sessionStore: { update: jest.Mock };
  let twilioService: { sendWhatsAppMessage: jest.Mock };
  let sharedService: {
    findOrCreateCustomer: jest.Mock;
    formatLocationSection: jest.Mock;
    endRelayForEndedRequest: jest.Mock;
  };
  let dispatchService: { startDispatch: jest.Mock };
  let customerFlowService: { scheduleRatingTimeout: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rescueRequest: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'req-1',
          customerId: 'cust-1',
          status: 'WAITING_FOR_DEPOSIT',
          balanceAmount: 200000,
          depositAmount: 50000,
          serviceFeeAmount: 25000,
          assignedOperatorId: 'op-1',
          customer: { phoneNumber: '+2348012345678' },
          assignedOperator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2349012345678',
          },
        }),
      },
      dispatchOffer: { updateMany: jest.fn() },
      payment: { update: jest.fn() },
    };
    payoutServiceMock = { createAndProcessPayout: jest.fn() };
    sessionStore = { update: jest.fn() };
    twilioService = { sendWhatsAppMessage: jest.fn() };
    sharedService = {
      findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
      formatLocationSection: jest
        .fn()
        .mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      endRelayForEndedRequest: jest.fn(),
    };
    dispatchService = { startDispatch: jest.fn() };
    customerFlowService = { scheduleRatingTimeout: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentEventsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PaymentLedgerService,
          useValue: createPaymentLedgerMock(),
        },
        {
          provide: PaystackCustomerService,
          useValue: createPaystackCustomerServiceMock(),
        },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: twilioService },
        { provide: PayoutService, useValue: payoutServiceMock },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestSharedService, useValue: sharedService },
        { provide: DispatchService, useValue: dispatchService },
        { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
      ],
    }).compile();

    service = module.get<PaymentEventsService>(PaymentEventsService);
  });

  describe('confirmDeposit', () => {
    // Redelivery/race idempotency is no longer this method's job — the
    // caller's own claim on the Payment row (claimTerminal's CAS) is what
    // guarantees confirmDeposit is reached at most once per settlement, and
    // that CAS is already covered in payment-ledger.int-spec.ts. This
    // method now trusts its caller and always proceeds when called.

    it('assigns the operator and confirms for a WAITING_FOR_DEPOSIT request', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'OPERATOR_ASSIGNED' },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining('operator is on the way'),
      );
    });

    it('cancels a paid deposit with no preassigned operator instead of dispatching after payment', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: null,
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'CANCELLED' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: 'IDLE',
        rescueRequestId: undefined,
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rescueRequestId: 'req-1',
          status: { in: ['PENDING', 'SELECTED_PENDING_PAYMENT'] },
        },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'QUOTED' },
        data: { status: 'NOT_SELECTED', respondedAt: expect.any(Date) },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining('flagged it for refund'),
      );
      expect(dispatchService.startDispatch).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Deposit confirmed without an assigned operator',
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('routes to handleLateDeposit for a CANCELLED request, and writes nothing — eligibility is derived', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining("We're processing a refund"),
      );
      expect(dispatchService.startDispatch).not.toHaveBeenCalled();
    });

    it('alerts Sentry and does nothing automatic for an unexpected non-CANCELLED status', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'ARRIVED', // some other status, neither WAITING_FOR_DEPOSIT nor CANCELLED
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Deposit confirmed in unexpected (non-CANCELLED) status',
        expect.objectContaining({ level: 'error' }),
      );
    });
  });

  describe('confirmBalance — payout trigger', () => {
    // As with confirmDeposit: redelivery/race idempotency is the caller's
    // claim on the Payment row, not this method's job any more.
    const BALANCE_REQUEST_FIXTURE = {
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 200000,
      depositAmount: 50000,
      serviceFeeAmount: 25000,
      assignedOperatorId: 'op-1',
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      },
    };

    beforeEach(() => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue(
        BALANCE_REQUEST_FIXTURE,
      );
    });

    it('completes the request unconditionally — the Payment CAS is what guarantees exactly once', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('triggers a payout for depositAmount + balanceAmount - serviceFeeAmount', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith(
        'req-1',
        'op-1',
        225000,
      );
    });

    it('invites a phone-only customer to create a portal account', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/register/customer'),
      );
    });

    it('releases any open chat relay — otherwise it swallows the rating replies prompted just below', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(sharedService.endRelayForEndedRequest).toHaveBeenCalledWith(
        'req-1',
      );
    });

    it('identifies the completed job and rated party in both rating prompts', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('Swift Towing on Job #REQ-1'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2349012345678',
        expect.stringContaining('the customer on Job #REQ-1'),
      );
    });

    it('tells a customer who already has portal credentials to log in instead', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        ...BALANCE_REQUEST_FIXTURE,
        customer: {
          phoneNumber: '+2348012345678',
          email: 'ada@example.com',
          passwordHash: 'hashed',
        },
      });

      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/login'),
      );
    });
  });

  describe('markJobCompleted', () => {
    it('blocks a request that was ever disputed, resolved or not', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: true,
        disputeResolvedAt: new Date('2026-01-01'),
        payments: [],
        customer: { phoneNumber: '+2348012345678' },
      });

      await expect(service.markJobCompleted('req-1')).rejects.toThrow(
        'unresolved dispute',
      );
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('proceeds normally for a request that was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: false,
        disputeResolvedAt: null,
        // No succeeded BALANCE payment — derived depositPaid/balancePaid
        // replacement for the old balancePaid: false.
        payments: [],
        balanceAmount: 45000,
        customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      const paystackService = {
        initializePayment: jest.fn().mockResolvedValue({
          outcome: 'ok',
          data: {
            authorization_url: 'https://pay.example/1',
            access_code: 'acc_1',
            reference: 'BAL_pay-1',
          },
        }),
      };
      (service as any).paystackService = paystackService;

      await service.markJobCompleted('req-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('does not send a balance link when a succeeded BALANCE payment already exists', async () => {
      const paystackService = { initializePayment: jest.fn() };
      (service as any).paystackService = paystackService;
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: false,
        disputeResolvedAt: null,
        payments: [{ type: 'BALANCE', status: 'SUCCEEDED' }],
        balanceAmount: 45000,
        customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });

      await service.markJobCompleted('req-1');

      expect(paystackService.initializePayment).not.toHaveBeenCalled();
    });
  });
});
