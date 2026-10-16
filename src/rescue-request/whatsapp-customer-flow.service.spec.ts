import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { createPaymentLedgerMock } from '../payment/testing/payment-ledger.mock';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { createPaystackCustomerServiceMock } from '../payment/testing/paystack-customer.mock';
import {
  TwilioMediaDownloadError,
  TwilioService,
} from '../integrations/twilio/twilio.service';
import { S3Service } from '../integrations/s3/s3.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { RatingService } from '../rating/rating.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { OperatorService } from '../operator/operator.service';
import { DispatchService } from './dispatch.service';
import { DisputeService } from './dispute.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import {
  WhatsAppFlowState,
  WhatsAppSession,
} from './state/whatsapp-session.types';
import { MediaContext, MediaType, UserRole } from '@prisma/client';

describe('WhatsAppCustomerFlowService', () => {
  describe('handleRatingReply', () => {
    let ratingTestService: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn(), getOrCreate: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: {} },
          { provide: S3Service, useValue: {} },
          {
            provide: GeocodingService,
            useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) },
          },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      ratingTestService = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('creates a MOTORIST_TO_OPERATOR rating for a valid customer-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
      });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-1' });

      await ratingTestService.handleRatingReply(
        'cust-1',
        '5',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        direction: 'MOTORIST_TO_OPERATOR',
        operatorId: 'op-1',
        customerId: 'cust-1',
        score: 5,
      });
    });

    it('creates an OPERATOR_TO_MOTORIST rating for a valid operator-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
      });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-2' });

      await ratingTestService.handleRatingReply(
        'op-user-1',
        '4',
        'req-1',
        'OPERATOR_TO_MOTORIST',
      );

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        direction: 'OPERATOR_TO_MOTORIST',
        operatorId: 'op-1',
        customerId: 'cust-1',
        score: 4,
      });
    });

    it('re-prompts and does not create a rating for invalid input', async () => {
      const response = await ratingTestService.handleRatingReply(
        'cust-1',
        'banana',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(response).toContain(
        'rate your experience with the operator for Job #REQ-1',
      );
      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('re-prompts and does not create a rating for an out-of-range number', async () => {
      const response = await ratingTestService.handleRatingReply(
        'op-user-1',
        '7',
        'req-1',
        'OPERATOR_TO_MOTORIST',
      );

      expect(response).toContain(
        'rate your experience with the customer for Job #REQ-1',
      );
      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });
  });

  describe('handleRatingReply — low rating staff alert', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            customerId: 'cust-1',
            assignedOperatorId: 'op-1',
          }),
        },
      };
      sessionStore = { update: jest.fn() };
      ratingServiceMock = {
        create: jest.fn().mockResolvedValue({ id: 'rating-1' }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = {
        getConfig: jest
          .fn()
          .mockResolvedValue({ disputeAlertPhoneNumbers: ['+2348099999999'] }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('alerts staff on a 1-2 star rating from the customer', async () => {
      await service.handleRatingReply(
        'cust-1',
        '2',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348099999999'),
        expect.stringContaining('Customer rated the operator'),
      );
    });

    it('alerts staff on a 1-2 star rating from the operator', async () => {
      await service.handleRatingReply(
        'op-user-1',
        '1',
        'req-1',
        'OPERATOR_TO_MOTORIST',
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348099999999'),
        expect.stringContaining('Operator rated the customer'),
      );
    });

    it('does not alert staff on a 3+ star rating', async () => {
      await service.handleRatingReply(
        'cust-1',
        '3',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('skips the alert cleanly when disputeAlertPhoneNumbers is empty', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumbers: [],
      });

      await service.handleRatingReply(
        'cust-1',
        '1',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('alerts every configured staff number on a low rating', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumbers: ['+2348099999999', '+2348088888888'],
      });

      await service.handleRatingReply(
        'cust-1',
        '1',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348099999999'),
        expect.stringContaining('Customer rated the operator'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348088888888'),
        expect.stringContaining('Customer rated the operator'),
      );
    });

    it('alerting one bad staff number does not block alerting the rest', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumbers: ['+2348099999999', '+2348088888888'],
      });
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to.includes('+2348099999999'))
          return Promise.reject(new Error('send failed'));
        return Promise.resolve();
      });

      await service.handleRatingReply(
        'cust-1',
        '1',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348088888888'),
        expect.stringContaining('Customer rated the operator'),
      );
    });
  });

  describe('WAITING_FOR_MEDIA — new-request staff alert', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: {
      requestMedia: { count: jest.Mock };
      user: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
    };
    let sessionStore: { update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let dispatchService: { startDispatch: jest.Mock };
    const phoneNumber = '+2348012345678';
    const userId = 'user-1';
    const session = {
      state: WhatsAppFlowState.WAITING_FOR_MEDIA,
      rescueRequestId: 'req-1',
    } as WhatsAppSession;

    beforeEach(async () => {
      prisma = {
        requestMedia: { count: jest.fn().mockResolvedValue(1) },
        user: {
          findUnique: jest.fn().mockResolvedValue({ id: userId, name: null }),
        },
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            vehicleType: 'SEDAN',
            destination: 'Lekki Phase 1',
            issueType: 'BREAKDOWN',
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      sessionStore = { update: jest.fn() };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = {
        getConfig: jest
          .fn()
          .mockResolvedValue({ newRequestAlertPhoneNumbers: [] }),
      };
      dispatchService = { startDispatch: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: dispatchService },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    async function continueToDispatch() {
      return service.handleCustomerMessage(
        phoneNumber,
        userId,
        '2',
        '2',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );
    }

    it('does not alert staff when no new-request alert number is configured', async () => {
      await continueToDispatch();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        phoneNumber,
        expect.stringContaining('Searching for nearby tow operators'),
      );
    });

    it('alerts every configured staff number once a request becomes dispatch-ready', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        newRequestAlertPhoneNumbers: ['+2348077777777', '+2348066666666'],
      });

      await continueToDispatch();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348077777777'),
        expect.stringContaining('Lekki Phase 1'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348066666666'),
        expect.stringContaining('Lekki Phase 1'),
      );
    });

    it('alerting one bad staff number does not block alerting the rest or the customer confirmation', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        newRequestAlertPhoneNumbers: ['+2348077777777', '+2348066666666'],
      });
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to.includes('+2348077777777'))
          return Promise.reject(new Error('send failed'));
        return Promise.resolve();
      });

      await continueToDispatch();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348066666666'),
        expect.stringContaining('Lekki Phase 1'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        phoneNumber,
        expect.stringContaining('Searching for nearby tow operators'),
      );
      expect(dispatchService.startDispatch).toHaveBeenCalled();
    });

    it('a failing config fetch for the staff alert never blocks the customer confirmation or dispatch start', async () => {
      platformConfigService.getConfig.mockRejectedValue(
        new Error('config unavailable'),
      );

      await continueToDispatch();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        phoneNumber,
        expect.stringContaining('Searching for nearby tow operators'),
      );
      expect(dispatchService.startDispatch).toHaveBeenCalled();
    });
  });

  describe('WAITING_FOR_DESTINATION', () => {
    let destService: WhatsAppCustomerFlowService;
    let prisma: {
      rescueRequest: { create: jest.Mock };
    };
    let sessionStore: { update: jest.Mock };
    let geocodingService: { reverseGeocode: jest.Mock };
    let sharedService: { findOrCreateCustomer: jest.Mock };
    const phoneNumber = '+2348012345678';
    const userId = 'user-1';
    const baseSession = {
      state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      latitude: 6.5,
      longitude: 3.4,
      vehicleType: 'SEDAN',
    } as any;

    beforeEach(async () => {
      prisma = {
        rescueRequest: { create: jest.fn().mockResolvedValue({ id: 'req-1' }) },
      };
      sessionStore = { update: jest.fn() };
      geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };
      sharedService = {
        findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1' }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          {
            provide: TwilioService,
            useValue: { sendWhatsAppMessage: jest.fn() },
          },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: geocodingService },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      destService = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('uses WhatsApp\'s own formatted address when a "search for a place" share includes one', async () => {
      await destService.handleCustomerMessage(
        phoneNumber,
        userId,
        '',
        '',
        6.6,
        3.5,
        'Mechanic Village, Ojodu',
        baseSession,
        {},
      );

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
      expect(sessionStore.update).toHaveBeenCalledWith(userId, {
        destination: 'Mechanic Village, Ojodu',
        state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      });
    });

    it('reverse-geocodes a bare "current location" pin with no Address field', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(
        '14 Adeniyi Jones Ave, Ikeja, Lagos',
      );

      await destService.handleCustomerMessage(
        phoneNumber,
        userId,
        '',
        '',
        6.6,
        3.5,
        undefined,
        baseSession,
        {},
      );

      expect(geocodingService.reverseGeocode).toHaveBeenCalledWith(6.6, 3.5);
      expect(sessionStore.update).toHaveBeenCalledWith(userId, {
        destination: '14 Adeniyi Jones Ave, Ikeja, Lagos',
        state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      });
    });

    it('falls back to raw coordinates when a pin is shared but geocoding fails', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      await destService.handleCustomerMessage(
        phoneNumber,
        userId,
        '',
        '',
        6.6,
        3.5,
        undefined,
        baseSession,
        {},
      );

      expect(sessionStore.update).toHaveBeenCalledWith(userId, {
        destination: '6.6, 3.5',
        state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      });
    });

    it('still accepts typed text destinations unchanged', async () => {
      const result = await destService.handleCustomerMessage(
        phoneNumber,
        userId,
        'mainland towing yard',
        'Mainland Towing Yard',
        undefined,
        undefined,
        undefined,
        baseSession,
        {},
      );

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(sessionStore.update).toHaveBeenCalledWith(userId, {
        destination: 'Mainland Towing Yard',
        state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      });
      expect(result).toContain("What's wrong");
    });

    it('prompts again when neither text nor a pin is provided', async () => {
      const result = await destService.handleCustomerMessage(
        phoneNumber,
        userId,
        '',
        '',
        undefined,
        undefined,
        undefined,
        baseSession,
        {},
      );

      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
      expect(result).toContain('type where you');
    });
  });

  describe('WAITING_FOR_ISSUE_TYPE', () => {
    let issueService: WhatsAppCustomerFlowService;
    let prisma: {
      rescueRequest: { create: jest.Mock };
      user: { updateMany: jest.Mock };
      $transaction: jest.Mock;
    };
    let sessionStore: { update: jest.Mock };
    let sharedService: { findOrCreateCustomer: jest.Mock };
    const phoneNumber = '+2348012345678';
    const userId = 'user-1';
    const baseSession: WhatsAppSession = {
      userId,
      state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      latitude: 6.5,
      longitude: 3.4,
      vehicleType: 'SEDAN',
      destination: 'Mainland Towing Yard',
      updatedAt: new Date(),
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { create: jest.fn().mockResolvedValue({ id: 'req-1' }) },
        user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
      };
      sessionStore = { update: jest.fn() };
      sharedService = {
        findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1' }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          {
            provide: TwilioService,
            useValue: { sendWhatsAppMessage: jest.fn() },
          },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      issueService = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('reprompts on an unrecognized reply, without creating the request', async () => {
      const result = await issueService.handleCustomerMessage(
        phoneNumber,
        userId,
        'huh',
        'huh',
        undefined,
        undefined,
        undefined,
        baseSession,
        {},
      );

      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
      expect(result).toContain('1-4');
    });

    it('creates the request with issueType and the destination carried over from session, then asks for media', async () => {
      const result = await issueService.handleCustomerMessage(
        phoneNumber,
        userId,
        '3',
        '3',
        undefined,
        undefined,
        undefined,
        baseSession,
        {},
      );

      expect(prisma.rescueRequest.create).toHaveBeenCalledWith({
        data: {
          customerId: 'cust-1',
          status: 'WAITING_FOR_MEDIA',
          latitude: 6.5,
          longitude: 3.4,
          vehicleType: 'SEDAN',
          destination: 'Mainland Towing Yard',
          issueType: 'FLAT_TYRE',
        },
      });
      expect(sessionStore.update).toHaveBeenCalledWith(userId, {
        rescueRequestId: 'req-1',
        state: WhatsAppFlowState.WAITING_FOR_MEDIA,
      });
      expect(result).toContain('photo or video');
    });

    it('also accepts the word reply, not just the number', async () => {
      await issueService.handleCustomerMessage(
        phoneNumber,
        userId,
        'accident',
        'accident',
        undefined,
        undefined,
        undefined,
        baseSession,
        {},
      );

      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: 'ACCIDENT' }),
        }),
      );
    });

    it('aborts request creation when the customer was deleted before the transaction commits', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        issueService.handleCustomerMessage(
          phoneNumber,
          userId,
          '3',
          '3',
          undefined,
          undefined,
          undefined,
          baseSession,
          {},
        ),
      ).rejects.toThrow('This account is no longer active.');

      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('WAITING_FOR_QUOTE_SELECTION', () => {
    let service: WhatsAppCustomerFlowService;
    let transactionFinished: boolean;
    let prisma: {
      $transaction: jest.Mock;
      user: { updateMany: jest.Mock };
      operator: { updateMany: jest.Mock };
      rescueRequest: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
        update: jest.Mock;
      };
      dispatchOffer: {
        findMany: jest.Mock;
        update: jest.Mock;
        updateMany: jest.Mock;
      };
      payment: { update: jest.Mock };
    };
    let paymentLedger: ReturnType<typeof createPaymentLedgerMock>;
    let paystackService: { initializePayment: jest.Mock };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let paymentEventsService: { activateAssignedJob: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    const session = {
      state: WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION,
      rescueRequestId: 'req-1',
    } as WhatsAppSession;

    beforeEach(async () => {
      transactionFinished = false;
      const operator = {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2348011111111',
        latitude: 6.5,
        longitude: 3.4,
      };
      prisma = {
        $transaction: jest.fn(),
        user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        operator: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            customerId: 'cust-1',
            status: 'DISPATCHING',
            latitude: 6.51,
            longitude: 3.41,
            customer: { id: 'cust-1', phoneNumber: '+2348022222222' },
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn(),
        },
        dispatchOffer: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'offer-1',
              rescueRequestId: 'req-1',
              operatorId: 'op-1',
              status: 'QUOTED',
              quotedPrice: 100_000,
              operator,
            },
          ]),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
        payment: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          const result = await callback(prisma);
          transactionFinished = true;
          return result;
        },
      );
      paymentLedger = createPaymentLedgerMock();
      paystackService = {
        initializePayment: jest.fn().mockImplementation(() => {
          expect(transactionFinished).toBe(true);
          return Promise.resolve({
            outcome: 'ok',
            data: {
              authorization_url: 'https://paystack.test/pay/xyz',
              access_code: 'acc-1',
              reference: 'DEP_pay-1',
            },
          });
        }),
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue(session),
        update: jest.fn(),
      };
      paymentEventsService = { activateAssignedJob: jest.fn() };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaymentLedgerService, useValue: paymentLedger },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          {
            provide: TwilioService,
            useValue: twilioService,
          },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: paystackService },
          {
            provide: PlatformConfigService,
            useValue: {
              getConfig: jest.fn().mockResolvedValue({
                serviceFeePercent: 10,
                depositPercent: 20,
              }),
            },
          },
          {
            provide: OperatorService,
            useValue: { calculateDistance: jest.fn().mockReturnValue(1) },
          },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: paymentEventsService },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    const selectFirstQuote = () =>
      service.handleCustomerMessage(
        '+2348022222222',
        'cust-1',
        '1',
        '1',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

    it('commits the assignment, offer transitions, and deposit before Paystack', async () => {
      await selectFirstQuote();

      expect(prisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'cust-1', deletedAt: null } }),
      );
      expect(prisma.operator.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'op-1', deletedAt: null } }),
      );
      expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1', status: 'DISPATCHING' },
          data: expect.objectContaining({
            assignedOperatorId: 'op-1',
            status: 'WAITING_FOR_DEPOSIT',
            depositAmount: 22_000,
          }),
        }),
      );
      expect(prisma.dispatchOffer.update).toHaveBeenCalled();
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(2);
      expect(paymentLedger.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        type: 'DEPOSIT',
        amount: 22_000,
        tx: prisma,
      });
      expect(transactionFinished).toBe(true);
      expect(paystackService.initializePayment).toHaveBeenCalledTimes(1);
    });

    it('stops before assignment when the selected operator was deleted', async () => {
      prisma.operator.updateMany.mockResolvedValue({ count: 0 });

      const result = await selectFirstQuote();

      expect(result).toContain('operator is no longer available');
      expect(prisma.user.updateMany).toHaveBeenCalled();
      expect(prisma.operator.updateMany).toHaveBeenCalled();
      expect(prisma.rescueRequest.updateMany).not.toHaveBeenCalled();
      expect(prisma.dispatchOffer.update).not.toHaveBeenCalled();
      expect(paymentLedger.create).not.toHaveBeenCalled();
      expect(paystackService.initializePayment).not.toHaveBeenCalled();
    });

    it("charges the snapshotted percentage, not the operator's current setting", async () => {
      // The offer carries a frozen depositPercentSnapshot of 15% from
      // deliverQuoteShortlist (Task 3) — deliberately different from both
      // the live platform default (config.depositPercent: 20, from this
      // block's beforeEach) and the operator's live depositPercentOverride
      // (50%, changed since the shortlist was frozen). Neither of those
      // other two values must be read here; only the frozen snapshot should
      // drive the calculation.
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 100_000,
          depositPercentSnapshot: 15,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2348011111111',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: 50,
          },
        },
      ]);

      await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

      // total = 100,000 + 10% service fee (10,000) = 110,000.
      // 15% of 110,000 = 16,500. (config's 20% would be 22,000; the
      // operator's live 50% would be 55,000 — neither must win.)
      const [{ data }] = prisma.rescueRequest.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.depositAmount).toBe(16_500);
    });

    it('skips the Paystack deposit step and activates the job directly when the snapshot resolves to 0%', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 100_000,
          depositPercentSnapshot: 0,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2348011111111',
            latitude: 6.5,
            longitude: 3.4,
          },
        },
      ]);

      await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

      const [{ data }] = prisma.rescueRequest.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.status).toBe('OPERATOR_ASSIGNED');
      expect(data.depositAmount).toBe(0);
      const [{ data: offerData }] = prisma.dispatchOffer.update.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(offerData.status).toBe('ACCEPTED');
      expect(paymentEventsService.activateAssignedJob).toHaveBeenCalledWith(
        'req-1',
      );
      expect(paymentLedger.create).not.toHaveBeenCalled();
      expect(paystackService.initializePayment).not.toHaveBeenCalled();
      // The customer's session must NOT be left at OPERATOR_FOUND_WAITING_PAYMENT
      // — there is no payment link coming, so a later message from the
      // customer must not be met with "please pay using the link we sent you".
      expect(sessionStore.update).not.toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ state: 'OPERATOR_FOUND_WAITING_PAYMENT' }),
      );
      // Failure isolation (same as Task 4's confirmDeposit fix): the
      // customer's own confirmation must be sent BEFORE activateAssignedJob
      // runs, so a failure inside activation can't silently swallow it.
      // Index by the customer's own phone number rather than assuming
      // call [0], in case the "notify losing operators" step above ever
      // also lands a call on this same mock.
      const customerMessageCallIndex =
        twilioService.sendWhatsAppMessage.mock.calls.findIndex(
          (call: unknown[]) => call[0] === '+2348000000000',
        );
      expect(customerMessageCallIndex).toBeGreaterThanOrEqual(0);
      const customerMessageOrder =
        twilioService.sendWhatsAppMessage.mock.invocationCallOrder[
          customerMessageCallIndex
        ];
      const activationOrder =
        paymentEventsService.activateAssignedJob.mock.invocationCallOrder[0];
      expect(customerMessageOrder).toBeLessThan(activationOrder);
      // The operator's phone number must be included so the customer can
      // actually reach them — the same information the paid-deposit path's
      // equivalent customer message already carries (confirmDeposit).
      const [, customerMessageBody] = twilioService.sendWhatsAppMessage.mock
        .calls[customerMessageCallIndex] as [string, string];
      expect(customerMessageBody).toContain('+2348011111111');
    });

    it('still activates the job (offer flip, session transitions) even when the customer-message send rejects, in the 0%-deposit branch', async () => {
      // A Twilio failure sending the customer's own "operator confirmed"
      // notification must never prevent activateAssignedJob from running —
      // that's the offer flip and both session transitions, which is what
      // actually matters operationally. Only the customer not getting one
      // WhatsApp message is at stake here, and that must be logged, not
      // allowed to swallow the rest.
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 100_000,
          depositPercentSnapshot: 0,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2348011111111',
            latitude: 6.5,
            longitude: 3.4,
          },
        },
      ]);
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to === '+2348000000000') {
          return Promise.reject(new Error('Twilio down'));
        }
        return Promise.resolve();
      });

      await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

      expect(paymentEventsService.activateAssignedJob).toHaveBeenCalledWith(
        'req-1',
      );
    });

    it('rounds a very small total at a nonzero percentage down to the 0%-deposit branch', async () => {
      // quotedPrice = 4 kobo. serviceFeeAmount = Math.round(4 * 10 / 100) = 0,
      // so total = 4. depositPercentSnapshot = 1 (NOT literally 0), but
      // Math.round(4 * 1 / 100) = Math.round(0.04) = 0 — the branch must key
      // off the computed depositAmount, not the raw stored percentage.
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 4,
          depositPercentSnapshot: 1,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2348011111111',
            latitude: 6.5,
            longitude: 3.4,
          },
        },
      ]);

      await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

      const [{ data }] = prisma.rescueRequest.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.status).toBe('OPERATOR_ASSIGNED');
      expect(data.depositAmount).toBe(0);
      const [{ data: offerData }] = prisma.dispatchOffer.update.mock
        .calls[0] as [{ data: Record<string, unknown> }];
      expect(offerData.status).toBe('ACCEPTED');
      expect(paymentLedger.create).not.toHaveBeenCalled();
      expect(paymentEventsService.activateAssignedJob).toHaveBeenCalledWith(
        'req-1',
      );
    });
  });

  describe('AWAITING_DISPUTE_REASON', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { update: jest.Mock } };
    let sessionStore: { update: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { update: jest.fn() } };
      sessionStore = { update: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          {
            provide: TwilioService,
            useValue: { sendWhatsAppMessage: jest.fn() },
          },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it("captures the customer's raw statement, reverts to AWAITING_COMPLETION_CONFIRM, and acknowledges", async () => {
      const session = {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId: 'req-1',
      } as any;

      const result = await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'the tow took 3 hours',
        'The tow took 3 hours, way longer than promised.',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: {
          customerDisputeStatement:
            'The tow took 3 hours, way longer than promised.',
        },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      });
      expect(result).toContain('recorded');
    });
  });

  describe('masked chat relay', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock };
    let sharedService: { findOrCreateCustomer: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    const operatorPhone = '+2348011112222';
    const customerPhone = '+2348012345678';

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn() };
      sharedService = {
        findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('CHAT DRIVER starts a relay on both sides when an operator is assigned', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
      });
      const session = {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: 'req-1',
      } as any;

      const result = await service.handleCustomerMessage(
        customerPhone,
        'cust-1',
        'chat driver',
        'chat driver',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        relayTarget: 'OPERATOR',
      });
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        relayTarget: 'CUSTOMER',
        rescueRequestId: 'req-1',
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('connected'),
      );
      expect(result).toContain('connected');
    });

    it('CHAT DRIVER replies with a clear message when no operator is assigned yet', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        assignedOperator: null,
      });
      const session = {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: 'req-1',
      } as any;

      const result = await service.handleCustomerMessage(
        customerPhone,
        'cust-1',
        'chat driver',
        'chat driver',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(result).toContain('No operator is assigned');
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('relays a plain message to the operator while relayTarget is set', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
      });
      const session = {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: 'req-1',
        relayTarget: 'OPERATOR',
      } as any;

      await service.handleCustomerMessage(
        customerPhone,
        'cust-1',
        'where are you',
        'Where are you?',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        'Customer: Where are you?',
      );
    });

    it('END CHAT clears relayTarget on both sides and notifies both', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
      });
      const session = {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: 'req-1',
        relayTarget: 'OPERATOR',
      } as any;

      await service.handleCustomerMessage(
        customerPhone,
        'cust-1',
        'end chat',
        'end chat',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        relayTarget: null,
      });
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        relayTarget: null,
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        'Chat ended.',
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        'Chat ended.',
      );
    });
  });

  describe('CONFIRM on an already-terminal request', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let paymentEventsService: { markJobCompleted: jest.Mock };
    let disputeService: { raiseDispute: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = {
        update: jest.fn(),
        // Defaults to IDLE — the normal (non-100%-deposit) case, where
        // settlement hasn't touched the session yet when CONFIRM re-fetches
        // it. Individual tests override this to simulate the 100%-deposit
        // case, where markJobCompleted's own side effect already moved the
        // session to WAITING_FOR_RATING by the time this is read.
        getOrCreate: jest
          .fn()
          .mockResolvedValue({ state: WhatsAppFlowState.IDLE }),
      };
      paymentEventsService = { markJobCompleted: jest.fn() };
      disputeService = { raiseDispute: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          {
            provide: TwilioService,
            useValue: { sendWhatsAppMessage: jest.fn() },
          },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: disputeService },
          { provide: PaymentEventsService, useValue: paymentEventsService },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('self-heals a stale session pointed at a CANCELLED request instead of calling markJobCompleted', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'CANCELLED',
        disputeResolvedAt: null,
      });
      const session = {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
      } as any;

      const result = await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'confirm',
        'confirm',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(paymentEventsService.markJobCompleted).not.toHaveBeenCalled();
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
      expect(result).toContain('already ended');
    });

    it('self-heals a stale session pointed at a COMPLETED request too', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'COMPLETED',
        disputeResolvedAt: null,
      });
      const session = {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
      } as any;

      const result = await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'confirm',
        'confirm',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(paymentEventsService.markJobCompleted).not.toHaveBeenCalled();
      expect(result).toContain('already ended');
    });

    it('proceeds normally when the request is still active, and still resets to IDLE for an ordinary (non-100%-deposit) job', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'ARRIVED',
        disputeResolvedAt: null,
      });
      // Normal job: markJobCompleted resolves without touching the session
      // itself — settlement (and any WAITING_FOR_RATING transition) happens
      // later, asynchronously, once the customer actually pays the balance.
      paymentEventsService.markJobCompleted.mockResolvedValue(undefined);
      const session = {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
      } as any;

      await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'confirm',
        'confirm',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(paymentEventsService.markJobCompleted).toHaveBeenCalledWith(
        'req-1',
      );
      // This must remain behavior-preserving for every non-100%-deposit
      // job: the IDLE reset still happens exactly as before the fix.
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
    });

    it('does NOT clobber the WAITING_FOR_RATING transition a 100%-deposit settlement already made', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'ARRIVED',
        disputeResolvedAt: null,
      });
      // 100%-deposit job: markJobCompleted's call chain reaches
      // finalizeJobSettlement synchronously (there's no balance to pay),
      // which moves the session straight to WAITING_FOR_RATING before this
      // resolves — mirrored here by having the mock itself call
      // sessionStore.update, same as the real settlement path does.
      paymentEventsService.markJobCompleted.mockImplementation(async () => {
        await sessionStore.update('cust-1', {
          state: WhatsAppFlowState.WAITING_FOR_RATING,
        });
      });
      sessionStore.getOrCreate.mockResolvedValue({
        state: WhatsAppFlowState.WAITING_FOR_RATING,
      });
      const session: WhatsAppSession = {
        userId: 'cust-1',
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
        updatedAt: new Date(),
      };

      await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'confirm',
        'confirm',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(paymentEventsService.markJobCompleted).toHaveBeenCalledWith(
        'req-1',
      );
      // The CONFIRM handler must never overwrite WAITING_FOR_RATING back to
      // IDLE once settlement has already moved the session there — doing so
      // would silently lose the customer's subsequent rating reply.
      expect(sessionStore.update).not.toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
    });

    it('DISPUTE self-heals a stale session pointed at a CANCELLED request instead of reopening the dispute', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'CANCELLED',
        disputeResolvedAt: null,
      });
      const session: WhatsAppSession = {
        userId: 'cust-1',
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
        updatedAt: new Date(),
      };

      const result = await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'dispute',
        'dispute',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(disputeService.raiseDispute).not.toHaveBeenCalled();
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
      expect(result).toContain('already ended');
    });

    it('DISPUTE self-heals a stale session pointed at a COMPLETED request — this is the exact gap that let a paid-in-full request be re-disputed and double-charged', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'COMPLETED',
        disputeResolvedAt: null,
      });
      const session: WhatsAppSession = {
        userId: 'cust-1',
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
        updatedAt: new Date(),
      };

      const result = await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'dispute',
        'dispute',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(disputeService.raiseDispute).not.toHaveBeenCalled();
      expect(result).toContain('already ended');
    });

    it('DISPUTE proceeds normally when the request is still active', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'ARRIVED',
        disputeResolvedAt: null,
      });
      const session: WhatsAppSession = {
        userId: 'cust-1',
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId: 'req-1',
        updatedAt: new Date(),
      };

      await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'dispute',
        'dispute',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(disputeService.raiseDispute).toHaveBeenCalledWith(
        'req-1',
        '+2348012345678',
        'cust-1',
      );
    });
  });

  describe('CANCEL active request', () => {
    type DispatchOfferUpdateManyArgs = {
      where: { rescueRequestId: string; status: string };
      data: { status: string; respondedAt: Date };
    };

    let service: WhatsAppCustomerFlowService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
      dispatchOffer: {
        updateMany: jest.Mock<void, [DispatchOfferUpdateManyArgs]>;
      };
    };
    let sessionStore: { clear: jest.Mock };
    let sharedService: { endRelayForEndedRequest: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            status: 'DISPATCHING',
            assignedOperator: null,
          }),
          update: jest.fn(),
        },
        dispatchOffer: {
          updateMany: jest.fn<void, [DispatchOfferUpdateManyArgs]>(),
        },
      };
      sessionStore = { clear: jest.fn() };
      sharedService = { endRelayForEndedRequest: jest.fn() };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('closes out QUOTED offers on cancel too, not just PENDING ones — otherwise a leftover QUOTED row can still reach the customer after they cancelled', async () => {
      const session: WhatsAppSession = {
        userId: 'cust-1',
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: 'req-1',
        updatedAt: new Date(),
      };

      await service.handleCustomerMessage(
        '+2348012345678',
        'cust-1',
        'cancel',
        'cancel',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      const [pendingCall, quotedCall] =
        prisma.dispatchOffer.updateMany.mock.calls;
      expect(pendingCall[0].where).toEqual({
        rescueRequestId: 'req-1',
        status: 'PENDING',
      });
      expect(pendingCall[0].data.status).toBe('TIMED_OUT');
      expect(pendingCall[0].data.respondedAt).toBeInstanceOf(Date);
      expect(quotedCall[0].where).toEqual({
        rescueRequestId: 'req-1',
        status: 'QUOTED',
      });
      expect(quotedCall[0].data.status).toBe('NOT_SELECTED');
      expect(quotedCall[0].data.respondedAt).toBeInstanceOf(Date);
    });

    it.each(['OPERATOR_ASSIGNED', 'IN_PROGRESS', 'ARRIVED', 'IN_DISPUTE'])(
      'refuses to self-cancel once %s — the deposit is paid and an operator has committed, so this must go through support instead',
      async (status) => {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1',
          status,
          assignedOperator: { phoneNumber: '+2349011111111' },
        });
        const session: WhatsAppSession = {
          userId: 'cust-1',
          state: WhatsAppFlowState.IDLE,
          rescueRequestId: 'req-1',
          updatedAt: new Date(),
        };

        const result = await service.handleCustomerMessage(
          '+2348012345678',
          'cust-1',
          'cancel',
          'cancel',
          undefined,
          undefined,
          undefined,
          session,
          {},
        );

        expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
        expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
        expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
        expect(result).toContain('contact support');
      },
    );

    it.each(['WAITING_FOR_DEPOSIT', 'DISPATCHING'])(
      'still allows self-cancel while %s — no deposit has been captured yet',
      async (status) => {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1',
          status,
          assignedOperator: null,
        });
        const session: WhatsAppSession = {
          userId: 'cust-1',
          state: WhatsAppFlowState.IDLE,
          rescueRequestId: 'req-1',
          updatedAt: new Date(),
        };

        const result = await service.handleCustomerMessage(
          '+2348012345678',
          'cust-1',
          'cancel',
          'cancel',
          undefined,
          undefined,
          undefined,
          session,
          {},
        );

        expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
          where: { id: 'req-1' },
          data: { status: 'CANCELLED' },
        });
        expect(result).toContain('You were not charged');
      },
    );
  });

  describe('captureMediaAttachment', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: { requestMedia: { create: jest.Mock } };
    let twilioService: { downloadMedia: jest.Mock };
    let s3Service: { uploadMedia: jest.Mock };

    beforeEach(async () => {
      prisma = { requestMedia: { create: jest.fn().mockResolvedValue({}) } };
      twilioService = {
        downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake')),
      };
      s3Service = { uploadMedia: jest.fn().mockResolvedValue(undefined) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: s3Service },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('saves the row tagged with the context and uploader role it was called with', async () => {
      const saved = await service.captureMediaAttachment(
        'req-1',
        'https://twilio.example/media/1',
        'image/jpeg',
        MediaContext.COMPLETION,
        UserRole.OPERATOR,
      );

      expect(saved).toBe(true);
      const [[{ data }]] = prisma.requestMedia.create.mock.calls as [
        [Record<string, unknown>],
      ];
      expect(data).toMatchObject({
        rescueRequestId: 'req-1',
        mediaType: MediaType.IMAGE,
        context: MediaContext.COMPLETION,
        uploadedByRole: UserRole.OPERATOR,
      });
    });

    it('treats a Twilio media 404 as an unavailable attachment, not a capture exception', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      twilioService.downloadMedia.mockRejectedValue(
        new TwilioMediaDownloadError(
          'https://twilio.example/media/missing',
          404,
          'Not Found',
        ),
      );

      const saved = await service.captureMediaAttachment(
        'req-1',
        'https://twilio.example/media/missing',
        'image/jpeg',
        MediaContext.COMPLETION,
        UserRole.OPERATOR,
      );

      expect(saved).toBe(false);
      expect(s3Service.uploadMedia).not.toHaveBeenCalled();
      expect(prisma.requestMedia.create).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Twilio media attachment was unavailable:',
        expect.objectContaining({
          rescueRequestId: 'req-1',
          twilioStatus: 404,
        }),
      );
      warnSpy.mockRestore();
    });
  });

  describe('handleCustomerMessage — dispute evidence', () => {
    let service: WhatsAppCustomerFlowService;
    let prisma: {
      rescueRequest: { update: jest.Mock; findUnique: jest.Mock };
      requestMedia: { count: jest.Mock; create: jest.Mock };
    };
    let sessionStore: { update: jest.Mock };
    let twilioService: { downloadMedia: jest.Mock };
    let s3Service: { uploadMedia: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn(),
        },
        requestMedia: {
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({}),
        },
      };
      sessionStore = { update: jest.fn().mockResolvedValue(undefined) };
      twilioService = {
        downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake')),
      };
      s3Service = { uploadMedia: jest.fn().mockResolvedValue(undefined) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: PaymentLedgerService,
            useValue: createPaymentLedgerMock(),
          },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: TwilioService, useValue: twilioService },
          { provide: S3Service, useValue: s3Service },
          { provide: GeocodingService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppCustomerFlowService>(
        WhatsAppCustomerFlowService,
      );
    });

    it('text-only statement ends the state exactly as before', async () => {
      const session = {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId: 'req-1',
      } as unknown as WhatsAppSession;

      await service.handleCustomerMessage(
        '+2348010000000',
        'cust-1',
        'the operator never showed up',
        'the operator never showed up',
        undefined,
        undefined,
        undefined,
        session,
        {},
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { customerDisputeStatement: 'the operator never showed up' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      });
    });

    it('media with no text saves the attachment and stays in the same state', async () => {
      const session = {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId: 'req-1',
      } as unknown as WhatsAppSession;

      const result = await service.handleCustomerMessage(
        '+2348010000000',
        'cust-1',
        '',
        '',
        undefined,
        undefined,
        undefined,
        session,
        {
          NumMedia: '1',
          MediaUrl0: 'https://twilio.example/media/7',
          MediaContentType0: 'image/jpeg',
        },
      );

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
      expect(result).toContain('Got it');
    });

    it('media plus text saves the attachment and ends the state', async () => {
      const session = {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId: 'req-1',
      } as unknown as WhatsAppSession;

      await service.handleCustomerMessage(
        '+2348010000000',
        'cust-1',
        'see attached',
        'see attached',
        undefined,
        undefined,
        undefined,
        session,
        {
          NumMedia: '1',
          MediaUrl0: 'https://twilio.example/media/8',
          MediaContentType0: 'image/jpeg',
        },
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { customerDisputeStatement: 'see attached' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      });
      expect(s3Service.uploadMedia).toHaveBeenCalled();
    });
  });
});
