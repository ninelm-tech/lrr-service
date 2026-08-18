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
import { DispatchService } from './dispatch.service';
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
{ provide: DispatchService, useValue: {} },
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
{ provide: DispatchService, useValue: {} },
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
{ provide: DispatchService, useValue: {} },
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
{ provide: DispatchService, useValue: {} },
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

  describe('handleOperatorQuoteOrDecline — concurrent-offer disambiguation', () => {
    let quoteService: RescueRequestService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };
    let dispatchService: { processQuoteOrDecline: jest.Mock };

    const offerA = { id: 'offer-a', rescueRequestId: 'req-aaaaaaAAAAAA', expiresAt: new Date() };
    const offerB = { id: 'offer-b', rescueRequestId: 'req-bbbbbbBBBBBB', expiresAt: new Date() };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn().mockResolvedValue({ id: 'op-1' }) },
        dispatchOffer: { findMany: jest.fn() },
      };
      dispatchService = {
        processQuoteOrDecline: jest.fn().mockResolvedValue({ quoted: true, message: 'ok' }),
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
          { provide: DispatchService, useValue: dispatchService },
        ],
      }).compile();

      quoteService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('uses the single pending offer when a bare price is given (unchanged, common case)', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect(dispatchService.processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('asks the operator to disambiguate instead of guessing when multiple offers are pending and no ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect(dispatchService.processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain('AAAAAA');
      expect(result).toContain('BBBBBB');
    });

    it('matches the correct offer when a job ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'AAAAAA');

      expect(dispatchService.processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('rejects a job ref that matches none of the pending offers', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'ZZZZZZ');

      expect(dispatchService.processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain("doesn't match");
    });
  });

});
