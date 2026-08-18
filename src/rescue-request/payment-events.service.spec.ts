import { Test, TestingModule } from '@nestjs/testing';
import { PaymentEventsService } from './payment-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestService } from './rescue-request.service';

describe('PaymentEventsService', () => {
  let service: PaymentEventsService;
  let prisma: {
    rescueRequest: { findFirst: jest.Mock; update: jest.Mock };
  };
  let payoutServiceMock: { createAndProcessPayout: jest.Mock };
  let sessionStore: { update: jest.Mock };
  let twilioService: { sendWhatsAppMessage: jest.Mock };
  let rescueRequestService: {
    findOrCreateCustomer: jest.Mock;
    scheduleRatingTimeout: jest.Mock;
    formatLocationSection: jest.Mock;
    startDispatch: jest.Mock;
  };

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
        update: jest.fn(),
      },
    };
    payoutServiceMock = { createAndProcessPayout: jest.fn() };
    sessionStore = { update: jest.fn() };
    twilioService = { sendWhatsAppMessage: jest.fn() };
    rescueRequestService = {
      findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
      scheduleRatingTimeout: jest.fn(),
      formatLocationSection: jest.fn().mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      startDispatch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentEventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: twilioService },
        { provide: PayoutService, useValue: payoutServiceMock },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestService, useValue: rescueRequestService },
      ],
    }).compile();

    service = module.get<PaymentEventsService>(PaymentEventsService);
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
});
