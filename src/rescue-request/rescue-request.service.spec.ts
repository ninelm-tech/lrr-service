import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { S3Service } from '../integrations/s3/s3.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { RatingService } from '../rating/rating.service';
import { PayoutService } from '../payout/payout.service';
import { DisputeService } from './dispute.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('RescueRequestService', () => {
  let service: RescueRequestService;
  let geocodingService: { reverseGeocode: jest.Mock };
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestService,
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: S3Service, useValue: {} },
        { provide: GeocodingService, useValue: geocodingService },
        { provide: PlatformConfigService, useValue: {} },
        { provide: RatingService, useValue: {} },
        { provide: PayoutService, useValue: {} },
        { provide: DisputeService, useValue: {} },
        { provide: PaymentEventsService, useValue: {} },
      ],
    }).compile();

    service = module.get<RescueRequestService>(RescueRequestService);
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('formatLocationSection', () => {
    it('returns the address plus a map link when reverse geocoding succeeds', async () => {
      geocodingService.reverseGeocode.mockResolvedValue('12 Adeniyi Jones Ave, Ikeja, Lagos');

      const result = await (service as any).formatLocationSection(6.5, 3.4);

      expect(result).toBe('12 Adeniyi Jones Ave, Ikeja, Lagos\n📍 https://maps.google.com/?q=6.5,3.4');
    });

    it('falls back to the map link alone when reverse geocoding returns nothing', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      const result = await (service as any).formatLocationSection(6.5, 3.4);

      expect(result).toBe('https://maps.google.com/?q=6.5,3.4');
    });
  });



  describe('handleRatingReply (via WhatsApp router)', () => {
    let ratingTestService: RescueRequestService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn(), getOrCreate: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      ratingTestService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('creates a MOTORIST_TO_OPERATOR rating for a valid customer-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-1' });

      await (ratingTestService as any).handleRatingReply('cust-1', '5', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5,
      });
    });

    it('creates an OPERATOR_TO_MOTORIST rating for a valid operator-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-2' });

      await (ratingTestService as any).handleRatingReply('op-user-1', '4', 'req-1', 'OPERATOR_TO_MOTORIST');

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'OPERATOR_TO_MOTORIST', operatorId: 'op-1', customerId: 'cust-1', score: 4,
      });
    });

    it('re-prompts and does not create a rating for invalid input', async () => {
      await (ratingTestService as any).handleRatingReply('cust-1', 'banana', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('re-prompts and does not create a rating for an out-of-range number', async () => {
      await (ratingTestService as any).handleRatingReply('cust-1', '7', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });
  });

  describe('handleOperatorMessage — rating branch ordering', () => {
    let orderingService: RescueRequestService;
    let prisma: { operator: { findUnique: jest.Mock }; rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { operator: { findUnique: jest.fn() }, rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      orderingService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('routes a WAITING_FOR_RATING operator reply to the rating handler, not the quote parser', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-3' });

      const session = { state: WhatsAppFlowState.WAITING_FOR_RATING, rescueRequestId: 'req-1' } as any;
      const operator = { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111' };

      await (orderingService as any).handleOperatorMessage('+2341111111111', 'op-user-1', '4', session, operator);

      // handleOperatorQuoteOrDecline's quote path always starts with an
      // operator.findUnique lookup — asserting it was never called proves
      // the numeric reply was routed to the rating handler instead, not
      // treated as a bogus price quote.
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'OPERATOR_TO_MOTORIST', operatorId: 'op-1', customerId: 'cust-1', score: 4,
      });
    });
  });

  describe('WAITING_FOR_DESTINATION (via WhatsApp router)', () => {
    let destService: RescueRequestService;
    let prisma: {
      user: { upsert: jest.Mock };
      operator: { findUnique: jest.Mock };
      rescueRequest: { create: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let geocodingService: { reverseGeocode: jest.Mock };
    const phoneNumber = '+2348012345678';

    beforeEach(async () => {
      prisma = {
        user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        operator: { findUnique: jest.fn().mockResolvedValue(null) },
        rescueRequest: { create: jest.fn().mockResolvedValue({ id: 'req-1' }) },
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({
          state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
          latitude: 6.5, longitude: 3.4, vehicleType: 'SEDAN',
        }),
        update: jest.fn(),
      };
      geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: { sendWhatsAppMessage: jest.fn() } },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: geocodingService },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      destService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('uses WhatsApp\'s own formatted address when a "search for a place" share includes one', async () => {
      await destService.handleIncomingWhatsAppMessage({
        From: `whatsapp:${phoneNumber}`, Body: '', Latitude: '6.6', Longitude: '3.5', Address: 'Mechanic Village, Ojodu',
      });

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: 'Mechanic Village, Ojodu' }),
      }));
    });

    it('reverse-geocodes a bare "current location" pin with no Address field', async () => {
      geocodingService.reverseGeocode.mockResolvedValue('14 Adeniyi Jones Ave, Ikeja, Lagos');

      await destService.handleIncomingWhatsAppMessage({
        From: `whatsapp:${phoneNumber}`, Body: '', Latitude: '6.6', Longitude: '3.5',
      });

      expect(geocodingService.reverseGeocode).toHaveBeenCalledWith(6.6, 3.5);
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: '14 Adeniyi Jones Ave, Ikeja, Lagos' }),
      }));
    });

    it('falls back to raw coordinates when a pin is shared but geocoding fails', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      await destService.handleIncomingWhatsAppMessage({
        From: `whatsapp:${phoneNumber}`, Body: '', Latitude: '6.6', Longitude: '3.5',
      });

      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: '6.6, 3.5' }),
      }));
    });

    it('still accepts typed text destinations unchanged', async () => {
      await destService.handleIncomingWhatsAppMessage({ From: `whatsapp:${phoneNumber}`, Body: 'Mainland Towing Yard' });

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: 'Mainland Towing Yard' }),
      }));
    });

    it('prompts again when neither text nor a pin is provided', async () => {
      const result = await destService.handleIncomingWhatsAppMessage({ From: `whatsapp:${phoneNumber}`, Body: '' });

      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
      expect(result).toContain('type where you');
    });
  });

  describe('getDispatchBoard', () => {
    let boardService: RescueRequestService;
    let prisma: {
      rescueRequest: { findMany: jest.Mock };
      whatsAppSession: { findMany: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findMany: jest.fn() },
        whatsAppSession: { findMany: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      boardService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('queries DISPATCHING requests plus resolved ones from the last 60 minutes, with offers and round number', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          createdAt: new Date('2026-08-12T10:00:00Z'),
          customerId: 'cust-1',
          dispatchOffers: [
            {
              operatorId: 'op-1',
              status: 'PENDING',
              quotedPrice: null,
              offeredAt: new Date('2026-08-12T10:00:00Z'),
              respondedAt: null,
              operator: { businessName: 'Swift Towing' },
            },
          ],
        },
      ]);
      prisma.whatsAppSession.findMany.mockResolvedValue([
        { userId: 'cust-1', dispatchRound: 2 },
      ]);

      const result = await boardService.getDispatchBoard();

      expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: 'DISPATCHING' },
              {
                status: { in: ['OPERATOR_ASSIGNED', 'CANCELLED'] },
                updatedAt: { gte: expect.any(Date) },
              },
            ],
          },
        }),
      );
      expect(result).toEqual([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          round: 2,
          createdAt: new Date('2026-08-12T10:00:00Z'),
          offers: [
            {
              operatorId: 'op-1',
              businessName: 'Swift Towing',
              status: 'PENDING',
              quotedPrice: undefined,
              offeredAt: new Date('2026-08-12T10:00:00Z'),
              respondedAt: undefined,
            },
          ],
        },
      ]);
    });

    it('defaults round to 0 when no session is found for the customer', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1', status: 'DISPATCHING', vehicleType: null, destination: null,
          createdAt: new Date(), customerId: 'cust-1', dispatchOffers: [],
        },
      ]);
      prisma.whatsAppSession.findMany.mockResolvedValue([]);

      const result = await boardService.getDispatchBoard();

      expect(result[0].round).toBe(0);
    });
  });

  describe('expandRadiusNow', () => {
    let radiusService: RescueRequestService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { updateMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
      };
      sessionStore = { getOrCreate: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      radiusService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('rejects a request that is not DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'OPERATOR_ASSIGNED' });

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow('not currently DISPATCHING');
    });

    it('clears any active batch/grace timer, times out pending offers, and starts a new round with an expanded radius', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 1 });
      sessionStore.getOrCreate.mockResolvedValue({ dispatchRound: 1 });

      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);
      const existingTimer = setTimeout(() => {}, 100000);
      (radiusService as any).batchTimers.set('req-1', existingTimer);

      await radiusService.expandRadiusNow('req-1');

      expect((radiusService as any).batchTimers.has('req-1')).toBe(false);
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
      // round 1 → current radius approximated as 1 * RADIUS_EXPANSION_KM (2) = 2,
      // expanded by one more increment = 4
      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1', 4);

      clearTimeout(existingTimer);
    });
  });

  describe('manualOfferToOperator', () => {
    let manualService: RescueRequestService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operator: { findUnique: jest.Mock };
      dispatchOffer: { create: jest.Mock; updateMany: jest.Mock };
      requestMedia: { findMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        operator: { findUnique: jest.fn() },
        dispatchOffer: { create: jest.fn(), updateMany: jest.fn() },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({ offeredOperatorIds: ['op-already-tried'], dispatchRound: 1 }),
        update: jest.fn(),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      manualService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('rejects a request that is not DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'OPERATOR_ASSIGNED' });

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('not currently DISPATCHING');
    });

    it('rejects a missing or inactive operator', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', status: 'INACTIVE' });

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('not an active operator');
    });

    it('creates a single-operator round: offer created, WhatsApp sent, session updated, timer scheduled', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(prisma.dispatchOffer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          expiresAt: expect.any(Date),
        }),
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('2349012345678'),
        expect.stringContaining('NEW RESCUE JOB'),
      );
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        offeredOperatorIds: ['op-already-tried', 'op-1'],
      });
      expect((manualService as any).batchTimers.has('req-1')).toBe(true);

      // Clean up the real timer this test scheduled
      clearTimeout((manualService as any).batchTimers.get('req-1'));
    });

    it('supersedes a pre-existing batchTimers entry (e.g. an untracked-style automatic retry) instead of leaking it', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      // Simulate a previously-scheduled round-continuation timer (e.g. the
      // automatic DISPATCH_RETRY_MINUTES retry) sitting in batchTimers.
      const priorTimer = setTimeout(() => {}, 100000);
      (manualService as any).batchTimers.set('req-1', priorTimer);

      await manualService.manualOfferToOperator('req-1', 'op-1');

      // The prior timer must have been cleared/replaced, not overwritten
      // silently while still pending — batchTimers now holds a fresh timer.
      const newTimer = (manualService as any).batchTimers.get('req-1');
      expect(newTimer).toBeDefined();
      expect(newTimer).not.toBe(priorTimer);

      clearTimeout(newTimer);
      clearTimeout(priorTimer);
    });

    it('passes the current accumulated radius (not a hardcoded 0) to resolveBatch on timeout, and includes media links in the message', async () => {
      jest.useFakeTimers();
      const prevApiBaseUrl = process.env.API_BASE_URL;
      process.env.API_BASE_URL = 'https://api.example.com';
      try {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
          vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
        });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });
        prisma.requestMedia.findMany.mockResolvedValue([{ id: 'media-1' }]);
        // session.dispatchRound is 1 → currentRadius should be 1 * RADIUS_EXPANSION_KM (2), not 0
        sessionStore.getOrCreate.mockResolvedValue({ offeredOperatorIds: [], dispatchRound: 1 });

        const resolveBatchSpy = jest.spyOn(manualService as any, 'resolveBatch').mockResolvedValue(undefined);

        await manualService.manualOfferToOperator('req-1', 'op-1');

        expect(prisma.requestMedia.findMany).toHaveBeenCalledWith({ where: { rescueRequestId: 'req-1' } });
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('media-1'),
        );

        jest.advanceTimersByTime(5 * 60 * 1000);

        expect(resolveBatchSpy).toHaveBeenCalledWith('req-1', ['op-1'], 'cust-1', 2);
      } finally {
        jest.useRealTimers();
        process.env.API_BASE_URL = prevApiBaseUrl;
      }
    });
  });

  describe('handleOperatorQuoteOrDecline — concurrent-offer disambiguation', () => {
    let quoteService: RescueRequestService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };

    const offerA = { id: 'offer-a', rescueRequestId: 'req-aaaaaaAAAAAA', expiresAt: new Date() };
    const offerB = { id: 'offer-b', rescueRequestId: 'req-bbbbbbBBBBBB', expiresAt: new Date() };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn().mockResolvedValue({ id: 'op-1' }) },
        dispatchOffer: { findMany: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
        ],
      }).compile();

      quoteService = module.get<RescueRequestService>(RescueRequestService);
      jest.spyOn(quoteService as any, 'processQuoteOrDecline').mockResolvedValue({ quoted: true, message: 'ok' });
    });

    it('uses the single pending offer when a bare price is given (unchanged, common case)', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect((quoteService as any).processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('asks the operator to disambiguate instead of guessing when multiple offers are pending and no ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect((quoteService as any).processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain('AAAAAA');
      expect(result).toContain('BBBBBB');
    });

    it('matches the correct offer when a job ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'AAAAAA');

      expect((quoteService as any).processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('rejects a job ref that matches none of the pending offers', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'ZZZZZZ');

      expect((quoteService as any).processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain("doesn't match");
    });
  });

});
