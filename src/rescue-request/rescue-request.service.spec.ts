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
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
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
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PayoutService, useValue: {} },
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

  describe('handleBalancePaymentConfirmed — payout trigger', () => {
    let payoutTestService: RescueRequestService;
    let prisma: {
      rescueRequest: { findFirst: jest.Mock; update: jest.Mock };
      user: { upsert: jest.Mock };
    };
    let payoutServiceMock: { createAndProcessPayout: jest.Mock };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

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
        user: { upsert: jest.fn().mockResolvedValue({ id: 'op-user-1' }) },
      };
      payoutServiceMock = { createAndProcessPayout: jest.fn() };
      sessionStore = { update: jest.fn(), getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }) };
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
          { provide: PayoutService, useValue: payoutServiceMock },
        ],
      }).compile();

      payoutTestService = module.get<RescueRequestService>(RescueRequestService);
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('triggers a payout for depositAmount + balanceAmount - serviceFeeAmount', async () => {
      await payoutTestService.handleBalancePaymentConfirmed('BAL_ref');

      expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith('req-1', 'op-1', 225000);
    });
  });

  describe('DISPUTE handling (via WhatsApp router)', () => {
    let disputeTestService: RescueRequestService;
    let prisma: {
      user: { upsert: jest.Mock };
      operator: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };

    const rescueRequestId = 'req-1';
    const customerPhone = '+2348012345678';

    beforeEach(async () => {
      prisma = {
        user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        operator: { findUnique: jest.fn().mockResolvedValue(null) },
        rescueRequest: { findUnique: jest.fn(), update: jest.fn() },
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({
          state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
          rescueRequestId,
        }),
        update: jest.fn(),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = { getConfig: jest.fn().mockResolvedValue({ disputeAlertPhoneNumber: null }) };

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
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
        ],
      }).compile();

      disputeTestService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('first raise: sets disputed + disputeRaisedAt, sends customer ack, alerts staff when configured', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing' },
        balanceAmount: 22500, depositAmount: 2500, customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await disputeTestService.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date) },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('dispute has been logged'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348099999999',
        expect.stringContaining('Swift Towing'),
      );
    });

    it('skips the staff alert cleanly when disputeAlertPhoneNumber is unset', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null, balanceAmount: 22500, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

      await disputeTestService.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1); // customer ack only
    });

    it('repeat while unresolved: no DB write, no re-alert, distinct reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });

      await disputeTestService.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('already flagged'),
      );
    });

    it('reopen after resolution: clears disputeResolvedAt, refreshes disputeRaisedAt, re-alerts staff', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await disputeTestService.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date), disputeResolvedAt: null },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('reopened'),
      );
    });

    describe('resolveDispute', () => {
      it('rejects when the request was never disputed', async () => {
        prisma.rescueRequest.findUnique.mockResolvedValue({ id: rescueRequestId, disputed: false, disputeResolvedAt: null });

        await expect(disputeTestService.resolveDispute(rescueRequestId)).rejects.toThrow('never been disputed');
        expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      });

      it('is a no-op when already resolved — no DB write, no re-notification', async () => {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
          customer: { phoneNumber: customerPhone }, assignedOperator: null,
        });

        const result = await disputeTestService.resolveDispute(rescueRequestId);

        expect(result).toEqual({ resolved: true });
        expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
        expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      });

      it('resolves, notifies customer and assigned operator, best-effort on Twilio failure', async () => {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: rescueRequestId, disputed: true, disputeResolvedAt: null,
          customer: { phoneNumber: customerPhone },
          assignedOperator: { phoneNumber: '+2348099999999' },
        });
        prisma.rescueRequest.update.mockResolvedValue({});
        twilioService.sendWhatsAppMessage.mockRejectedValueOnce(new Error('Twilio down'));

        await expect(disputeTestService.resolveDispute(rescueRequestId)).resolves.toEqual({ resolved: true });

        expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
          where: { id: rescueRequestId },
          data: { disputeResolvedAt: expect.any(Date) },
        });
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // customer + operator, even though first rejected
      });
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

  describe('assignOperator', () => {
    let assignService: RescueRequestService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
      dispatchOffer: { create: jest.Mock; delete: jest.Mock; update: jest.Mock };
    };
    let paystackService: { generateReference: jest.Mock; initializePayment: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };

    const operator = { id: 'op-1', status: 'ACTIVE', businessName: 'Acme Towing', phoneNumber: '+2348011111111' };
    const request = {
      id: 'req-1',
      status: 'DISPATCHING',
      customerId: 'cust-1',
      customer: { id: 'cust-1', phoneNumber: '+2348022222222', email: null },
    };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn().mockResolvedValue(operator) },
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue(request),
          update: jest.fn().mockImplementation(({ data }) => ({ ...request, ...data, assignedOperator: operator })),
        },
        dispatchOffer: {
          create: jest.fn().mockResolvedValue({ id: 'offer-1' }),
          delete: jest.fn(),
          update: jest.fn(),
        },
      };
      paystackService = {
        generateReference: jest.fn().mockReturnValue('DEP_ref123'),
        initializePayment: jest.fn().mockResolvedValue({
          status: true,
          data: { authorization_url: 'https://paystack.test/pay/xyz' },
        }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = {
        getConfig: jest.fn().mockResolvedValue({ serviceFeePercent: 10, depositPercent: 20 }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
        ],
      }).compile();

      assignService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('splits the price into service fee, deposit, and balance, and creates a payment link', async () => {
      // Fake timers so the 5-minute deposit-window setTimeout this schedules
      // never becomes a real leaked OS timer.
      jest.useFakeTimers();
      try {
        // price 100_000 kobo, 10% fee -> total 110_000, 20% deposit -> 22_000 deposit, 88_000 balance
        const result = await assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 });

        expect(prisma.dispatchOffer.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            rescueRequestId: 'req-1',
            operatorId: 'op-1',
            status: 'SELECTED_PENDING_PAYMENT',
            quotedPrice: 100_000,
          }),
        });
        expect(paystackService.initializePayment).toHaveBeenCalledWith(
          expect.objectContaining({ amount: 22_000 }),
        );
        expect(prisma.rescueRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              assignedOperatorId: 'op-1',
              status: 'WAITING_FOR_DEPOSIT',
              serviceFeeAmount: 10_000,
              depositAmount: 22_000,
              balanceAmount: 88_000,
            }),
          }),
        );
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('https://paystack.test/pay/xyz'),
        );
        expect(result.data).toBeDefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects a non-active operator', async () => {
      prisma.operator.findUnique.mockResolvedValue({ ...operator, status: 'PENDING' });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow('Target is not an active operator');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('rejects a non-positive price (ValidationPipe is not wired up, so this is enforced manually)', async () => {
      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 0 }),
      ).rejects.toThrow('priceKobo must be a positive integer');
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the customer has no phone number on file', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...request,
        customer: { ...request.customer, phoneNumber: null },
      });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow('Customer has no phone number on file');
    });

    it('rolls back the created offer if the payment link fails to generate', async () => {
      paystackService.initializePayment.mockResolvedValue({ status: false });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow(`Couldn't generate a payment link`);

      expect(prisma.dispatchOffer.delete).toHaveBeenCalledWith({ where: { id: 'offer-1' } });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('releases the operator and reopens dispatch if the deposit window expires unpaid', async () => {
      jest.useFakeTimers();
      try {
        prisma.rescueRequest.findUnique
          .mockResolvedValueOnce(request) // initial lookup inside assignOperator
          .mockResolvedValueOnce({ status: 'WAITING_FOR_DEPOSIT' }); // still-unpaid check in the timeout

        const startDispatchSpy = jest.spyOn(assignService as any, 'startDispatch').mockResolvedValue(undefined);

        await assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 });

        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: expect.objectContaining({ status: 'TIMED_OUT' }),
        });
        expect(prisma.rescueRequest.update).toHaveBeenLastCalledWith({
          where: { id: 'req-1' },
          data: { assignedOperatorId: null, status: 'DISPATCHING' },
        });
        expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
