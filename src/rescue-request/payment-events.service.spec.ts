import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { PaymentEventsService } from './payment-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

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
        findFirst: jest.fn().mockResolvedValue({
          id: 'req-1',
          customerId: 'cust-1',
          balanceAmount: 200000,
          depositAmount: 50000,
          serviceFeeAmount: 25000,
          assignedOperatorId: 'op-1',
          customer: { phoneNumber: '+2348012345678' },
          assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2349012345678' },
        }),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      dispatchOffer: { updateMany: jest.fn() },
    };
    payoutServiceMock = { createAndProcessPayout: jest.fn() };
    sessionStore = { update: jest.fn() };
    twilioService = { sendWhatsAppMessage: jest.fn() };
    sharedService = {
      findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
      formatLocationSection: jest.fn().mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      endRelayForEndedRequest: jest.fn(),
    };
    dispatchService = { startDispatch: jest.fn() };
    customerFlowService = { scheduleRatingTimeout: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentEventsService,
        { provide: PrismaService, useValue: prisma },
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

  describe('handleDepositPaymentConfirmed', () => {
    it('assigns the operator and confirms when the claim succeeds', async () => {
      prisma.rescueRequest.findFirst.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2341' }, assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
      });
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });

      await service.handleDepositPaymentConfirmed('DEP_ref_1');

      expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', status: 'WAITING_FOR_DEPOSIT' },
        data: { depositPaid: true, status: 'OPERATOR_ASSIGNED' },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining('operator is on the way'),
      );
      expect(prisma.rescueRequest.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('is a silent no-op when the claim fails because the deposit was already paid (webhook redelivery)', async () => {
      prisma.rescueRequest.findFirst.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2341' }, assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
      });
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 }); // claim failed
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', depositPaid: true, status: 'OPERATOR_ASSIGNED', // already processed
      });

      await service.handleDepositPaymentConfirmed('DEP_ref_1');

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled(); // handleLateDeposit's write must not fire
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('routes to handleLateDeposit when the request is CANCELLED and not yet paid', async () => {
      prisma.rescueRequest.findFirst.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1',
        customer: { phoneNumber: '+2341' }, assignedOperator: null,
      });
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', customer: { phoneNumber: '+2341' }, depositPaid: false, status: 'CANCELLED',
      });
      prisma.rescueRequest.update.mockResolvedValue({});

      await service.handleDepositPaymentConfirmed('DEP_ref_1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { depositPaid: true, depositRefundStatus: 'ELIGIBLE' },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining("We're processing a refund"),
      );
      expect(dispatchService.startDispatch).not.toHaveBeenCalled();
    });

    it('alerts Sentry and does nothing automatic for an unexpected non-CANCELLED status', async () => {
      prisma.rescueRequest.findFirst.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1',
        customer: { phoneNumber: '+2341' }, assignedOperator: null,
      });
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', depositPaid: false, status: 'ARRIVED', // some other status, neither WAITING_FOR_DEPOSIT nor CANCELLED
      });

      await service.handleDepositPaymentConfirmed('DEP_ref_1');

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Deposit confirmed in unexpected (non-CANCELLED) status',
        expect.objectContaining({ level: 'error' }),
      );
    });
  });

  describe('handleBalancePaymentConfirmed — payout trigger', () => {
    it('triggers a payout for depositAmount + balanceAmount - serviceFeeAmount', async () => {
      await service.handleBalancePaymentConfirmed('BAL_ref');

      expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith('req-1', 'op-1', 225000);
    });

    it('invites a phone-only customer to create a portal account', async () => {
      await service.handleBalancePaymentConfirmed('BAL_ref');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/register/customer'),
      );
    });

    it('releases any open chat relay — otherwise it swallows the rating replies prompted just below', async () => {
      await service.handleBalancePaymentConfirmed('BAL_ref');

      expect(sharedService.endRelayForEndedRequest).toHaveBeenCalledWith('req-1');
    });

    it('tells a customer who already has portal credentials to log in instead', async () => {
      prisma.rescueRequest.findFirst.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', balanceAmount: 200000, depositAmount: 50000, serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678', email: 'ada@example.com', passwordHash: 'hashed' },
        assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2349012345678' },
      });

      await service.handleBalancePaymentConfirmed('BAL_ref');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/login'),
      );
    });
  });

  describe('markJobCompleted', () => {
    it('blocks a request that was ever disputed, resolved or not', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        balancePaid: false, customer: { phoneNumber: '+2348012345678' },
      });

      await expect(service.markJobCompleted('req-1')).rejects.toThrow('unresolved dispute');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('proceeds normally for a request that was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', disputed: false, disputeResolvedAt: null,
        balancePaid: false, balanceAmount: 45000, customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      const paystackService = { generateReference: jest.fn().mockReturnValue('BAL-1'), initializePayment: jest.fn().mockResolvedValue({ status: true, data: { authorization_url: 'https://pay.example/1' } }) };
      (service as any).paystackService = paystackService;

      await service.markJobCompleted('req-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });
  });
});
