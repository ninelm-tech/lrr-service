import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { S3Service } from '../integrations/s3/s3.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { RatingService } from '../rating/rating.service';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('RescueRequestService', () => {
  let service: RescueRequestService;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestService,
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: S3Service, useValue: {} },
        { provide: PlatformConfigService, useValue: {} },
        { provide: RatingService, useValue: {} },
      ],
    }).compile();

    service = module.get<RescueRequestService>(RescueRequestService);
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('buildMediaLinksSection', () => {
    it('returns an empty string when there are no media items', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([]);
      expect(result).toBe('');
    });

    it('returns an empty string when API_BASE_URL is not configured', () => {
      delete process.env.API_BASE_URL;
      const result = (service as any).buildMediaLinksSection([{ id: 'media-1' }]);
      expect(result).toBe('');
    });

    it('builds one /media/:id link per item under API_BASE_URL/api/v1', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([
        { id: 'media-1' },
        { id: 'media-2' },
      ]);
      expect(result).toBe(
        '\n\n📎 Photos/Video/Audio:\nhttps://api.lrr.ninelm.com/api/v1/media/media-1\nhttps://api.lrr.ninelm.com/api/v1/media/media-2',
      );
    });
  });

  describe('detailForUser — quote-compliance data', () => {
    let detailService: RescueRequestService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operatorMember: { findMany: jest.Mock };
    };
    let platformConfigService: { getConfig: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        operatorMember: { findMany: jest.fn() },
      };
      platformConfigService = { getConfig: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: RatingService, useValue: {} },
        ],
      }).compile();

      detailService = module.get<RescueRequestService>(RescueRequestService);
    });

    const baseRaw = {
      id: 'req-1',
      status: 'DISPATCHING',
      issueType: undefined,
      vehicleType: 'SEDAN',
      destination: 'Mainland',
      latitude: null,
      longitude: null,
      depositPaid: false,
      depositAmount: undefined,
      depositReference: undefined,
      balancePaid: false,
      balanceAmount: undefined,
      balanceReference: undefined,
      createdAt: new Date('2026-08-10T00:00:00Z'),
      updatedAt: new Date('2026-08-10T00:00:00Z'),
      customer: { id: 'cust-1', phoneNumber: '+2340000000000', email: null, name: null },
      assignedOperatorId: null,
      assignedOperator: null,
      media: [],
      dispatchOffers: [
        {
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 2500000,
          offeredAt: new Date('2026-08-10T00:00:00Z'),
          respondedAt: new Date('2026-08-10T00:05:00Z'),
          operator: { id: 'op-1', businessName: 'Swift Towing' },
        },
      ],
    };

    it('includes offers with computed motoristFacingTotal for ADMIN', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(baseRaw);
      platformConfigService.getConfig.mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 });

      const result = await detailService.detailForUser({ role: 'ADMIN', userId: 'admin-1' }, 'req-1');

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.destination).toBe('Mainland');
      expect(result.data.offers).toEqual([
        expect.objectContaining({
          operatorId: 'op-1',
          businessName: 'Swift Towing',
          quotedPrice: 2500000,
          motoristFacingTotal: 2750000,
        }),
      ]);
    });

    it('omits offers entirely for OPERATOR', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        assignedOperatorId: 'op-1',
        assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111', email: null },
      });
      prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

      const result = await detailService.detailForUser({ role: 'OPERATOR', userId: 'user-1' }, 'req-1');

      expect(result.data.offers).toBeUndefined();
    });

    it('returns data for a CUSTOMER who owns the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      const result = await detailService.detailForUser({ role: 'CUSTOMER', userId: 'cust-1' }, 'req-1');

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.offers).toBeUndefined();
    });

    it('rejects a CUSTOMER who does not own the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      await expect(
        detailService.detailForUser({ role: 'CUSTOMER', userId: 'someone-else' }, 'req-1'),
      ).rejects.toThrow('You do not have access to this rescue request');
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
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
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
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
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
});
