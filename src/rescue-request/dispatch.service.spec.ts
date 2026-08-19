import { Test, TestingModule } from '@nestjs/testing';
import { DispatchService } from './dispatch.service';
import { RescueRequestModule } from './rescue-request.module';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { ConfigModule } from '@nestjs/config';

describe('DispatchService', () => {
  it('registers as a singleton — two module resolutions return the same batchTimers instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), RescueRequestModule],
    })
      .overrideProvider(PrismaService).useValue({})
      .compile();
    const first = moduleRef.get(DispatchService);
    const second = moduleRef.get(DispatchService);
    expect(first).toBe(second);
  });

  describe('getDispatchBoard', () => {
    let boardService: DispatchService;
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
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      boardService = module.get<DispatchService>(DispatchService);
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
    let radiusService: DispatchService;
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
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      radiusService = module.get<DispatchService>(DispatchService);
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
    let manualService: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operator: { findUnique: jest.Mock };
      dispatchOffer: { create: jest.Mock; updateMany: jest.Mock };
      requestMedia: { findMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    afterEach(() => {
      if (originalTemplateSid === undefined) delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
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
      twilioService = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };
      sharedService = {
        formatLocationSection: jest.fn().mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      manualService = module.get<DispatchService>(DispatchService);
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

    it('sends via the approved Content Template (with N/A placeholders for the distance/ETA lines this path never computes) when TWILIO_DISPATCH_OFFER_TEMPLATE_SID is set', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest456';
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

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        'HXtest456',
        expect.objectContaining({
          '2': 'Sedan',
          '3': 'Lekki',
          '4': 'Distance: N/A',
          '7': 'ETA: N/A',
          '8': '5 minutes',
        }),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();

      clearTimeout((manualService as any).batchTimers.get('req-1'));
    });

    it('logs to Sentry and re-throws (does not silently succeed) when the send fails', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });
      twilioService.sendWhatsAppMessage.mockRejectedValue(new Error('63016: outside messaging window'));

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('63016');
    });
  });

  describe('startDispatch — batch operator notification', () => {
    let batchService: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      user: { findUnique: jest.Mock };
      operator: { count: jest.Mock };
      dispatchOffer: { createMany: jest.Mock };
      requestMedia: { findMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let operatorService: { findAndRankCandidates: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    const candidateA = { id: 'op-a', businessName: 'A Towing', phoneNumber: '+2349011111111', distance: 5.2 };
    const candidateB = { id: 'op-b', businessName: 'B Towing', phoneNumber: '+2349022222222', distance: 8.1 };

    afterEach(() => {
      if (originalTemplateSid === undefined) delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      prisma = {
        rescueRequest: { findUnique: jest.fn().mockResolvedValue({
          id: 'req-1', status: 'DISPATCHING', vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
        }) },
        user: { findUnique: jest.fn().mockResolvedValue({ phoneNumber: '+2348000000000' }) },
        operator: { count: jest.fn() },
        dispatchOffer: { createMany: jest.fn() },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({ offeredOperatorIds: [], dispatchRound: 0 }),
        update: jest.fn(),
      };
      operatorService = { findAndRankCandidates: jest.fn().mockResolvedValue([candidateA, candidateB]) };
      platformConfigService = { getConfig: jest.fn().mockResolvedValue({ dispatchWindowMinutes: 10 }) };
      twilioService = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };
      sharedService = { formatLocationSection: jest.fn().mockResolvedValue('https://maps.google.com/?q=6.5,3.4') };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: operatorService },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: sharedService },
        ],
      }).compile();

      batchService = module.get<DispatchService>(DispatchService);
    });

    it('sends via the Content Template, with per-operator distance/ETA lines, when TWILIO_DISPATCH_OFFER_TEMPLATE_SID is set', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349011111111'),
        'HXtest789',
        expect.objectContaining({ '4': 'Distance: 5.2 km', '5': 'https://maps.google.com/?q=6.5,3.4' }),
      );
      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        'HXtest789',
        expect.objectContaining({ '4': 'Distance: 8.1 km' }),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();

      clearTimeout((batchService as any).batchTimers.get('req-1'));
    });

    it('one operator send failing does not block the others in the batch, and is reported instead of thrown', async () => {
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to.includes('+2349011111111')) return Promise.reject(new Error('63016: outside messaging window'));
        return Promise.resolve();
      });

      await expect(batchService.startDispatch('req-1', 'cust-1')).resolves.toBeUndefined();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // both attempted
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        expect.any(String),
      ); // the other operator still got theirs

      clearTimeout((batchService as any).batchTimers.get('req-1'));
    });
  });
});
