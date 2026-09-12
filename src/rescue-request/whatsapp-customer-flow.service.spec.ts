import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
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
import { WhatsAppFlowState } from './state/whatsapp-session.types';

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
      await ratingTestService.handleRatingReply(
        'cust-1',
        'banana',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('re-prompts and does not create a rating for an out-of-range number', async () => {
      await ratingTestService.handleRatingReply(
        'cust-1',
        '7',
        'req-1',
        'MOTORIST_TO_OPERATOR',
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
          .mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
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

    it('skips the alert cleanly when disputeAlertPhoneNumber is unset', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumber: null,
      });

      await service.handleRatingReply(
        'cust-1',
        '1',
        'req-1',
        'MOTORIST_TO_OPERATOR',
      );

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
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
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destination: 'Mechanic Village, Ojodu',
          }),
        }),
      );
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
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destination: '14 Adeniyi Jones Ave, Ikeja, Lagos',
          }),
        }),
      );
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

      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ destination: '6.6, 3.5' }),
        }),
      );
    });

    it('still accepts typed text destinations unchanged', async () => {
      await destService.handleCustomerMessage(
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
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destination: 'Mainland Towing Yard',
          }),
        }),
      );
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
      expect(result).toContain('type where you');
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
    let sessionStore: { update: jest.Mock };
    let paymentEventsService: { markJobCompleted: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn() };
      paymentEventsService = { markJobCompleted: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
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

    it('proceeds normally when the request is still active', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'ARRIVED',
        disputeResolvedAt: null,
      });
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
    });
  });
});
