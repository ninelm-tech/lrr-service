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

/**
 * Batch timers are keyed `requestId:batchId`, so a test can't clear one by
 * request id alone. Tests that schedule real timers drain the whole map.
 */
function clearAllBatchTimers(service: DispatchService) {
  const timers = (service as any).batchTimers as Map<string, NodeJS.Timeout>;
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
}

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

  describe('batch identity survives the expiresAt rewrite', () => {
    it('resolveBatch (via maybeResolveBatchEarly) still finds offers sharing a batchId even when one has a rewritten, shorter expiresAt', async () => {
      // Simulates Task 5's transition: an offer's expiresAt can be shortened
      // independently of the rest of its batch. Lookups must key off batchId,
      // never expiresAt, or a rewritten offer silently drops out of its batch.
      const prisma = {
        rescueRequest: { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1' }) },
        dispatchOffer: {
          findMany: jest.fn().mockResolvedValue([
            { operatorId: 'op-1', status: 'QUOTED', expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
            { operatorId: 'op-2', status: 'DECLINED', expiresAt: new Date(Date.now() + 60 * 1000) }, // rewritten shorter
          ]),
        },
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
      const service = module.get<DispatchService>(DispatchService);

      const resolveBatchSpy = jest.spyOn(service as any, 'resolveBatch').mockResolvedValue(undefined);

      await (service as any).maybeResolveBatchEarly('req-1', 'batch-shared');

      expect(prisma.dispatchOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { rescueRequestId: 'req-1', batchId: 'batch-shared' } }),
      );
      expect(resolveBatchSpy).toHaveBeenCalledWith('req-1', ['op-1', 'op-2'], 'cust-1', 0, 'batch-shared');
    });
  });

  describe('processQuoteOrDecline — phase 2 (quote collection)', () => {
    let service: DispatchService;
    let prisma: any;
    let twilioService: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
    /** Stand-in for the persisted RescueRequest row, mutated by updateMany. */
    let row: { id: string; status: string; customerId: string; quoteCollectionDeadline: Date | null };
    const originalCountdownSid = process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;

    const offer = { id: 'offer-1', rescueRequestId: 'req-1', expiresAt: new Date(Date.now() + 600000), batchId: 'batch-1' };

    afterEach(() => {
      clearAllBatchTimers(service);
      const closeTimers = (service as any).closeTimers as Map<string, NodeJS.Timeout>;
      closeTimers.forEach((t) => clearTimeout(t));
      closeTimers.clear();
      if (originalCountdownSid === undefined) delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
      else process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID = originalCountdownSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
      row = { id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1', quoteCollectionDeadline: null };

      prisma = {
        rescueRequest: {
          findUnique: jest.fn(async () => ({ ...row })),
          // Models the atomic once-only set: the `quoteCollectionDeadline: null`
          // condition is what stops a second quote moving the deadline.
          updateMany: jest.fn(async ({ where, data }: any) => {
            if (where.quoteCollectionDeadline === null && row.quoteCollectionDeadline !== null) {
              return { count: 0 };
            }
            row.quoteCollectionDeadline = data.quoteCollectionDeadline;
            return { count: 1 };
          }),
        },
        dispatchOffer: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(1), // a straggler is still pending by default
        },
      };
      twilioService = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: { getConfig: jest.fn().mockResolvedValue({ quoteCollectionMinutes: 5 }) } },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('the first quote sets quoteCollectionDeadline and shortens every pending offer expiring later than it', async () => {
      jest.useFakeTimers();
      try {
        const result = await service.processQuoteOrDecline(offer, 2_500_000);

        expect(result.quoted).toBe(true);
        expect(row.quoteCollectionDeadline).toEqual(new Date(Date.now() + 5 * 60 * 1000));
        expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
          where: { id: 'req-1', quoteCollectionDeadline: null },
          data: { quoteCollectionDeadline: row.quoteCollectionDeadline },
        });
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
          where: { rescueRequestId: 'req-1', status: 'PENDING', expiresAt: { gt: row.quoteCollectionDeadline } },
          data: { expiresAt: row.quoteCollectionDeadline },
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('a second quote does not move the deadline — nothing is rewritten, no new close timer', async () => {
      jest.useFakeTimers();
      try {
        await service.processQuoteOrDecline(offer, 2_500_000);
        const deadlineAfterFirst = row.quoteCollectionDeadline!;
        prisma.dispatchOffer.updateMany.mockClear();
        prisma.dispatchOffer.findMany.mockClear();

        jest.advanceTimersByTime(60 * 1000); // a minute later — a later deadline would be visibly different
        const second = await service.processQuoteOrDecline(
          { ...offer, id: 'offer-2', batchId: 'batch-1' }, 2_600_000,
        );

        expect(second.quoted).toBe(true);
        // THE invariant.
        expect(row.quoteCollectionDeadline).toBe(deadlineAfterFirst);
        // Only the atomic claim on the offer itself — no expiresAt rewrite,
        // no second countdown notice.
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: 'offer-2' }) }),
        );
        expect(prisma.dispatchOffer.findMany).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects an offer that is still PENDING but already past its expiresAt (the sweep-gap case)', async () => {
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.processQuoteOrDecline(offer, 2_500_000);

      expect(result).toEqual({ quoted: false, message: 'Sorry, that offer has expired.' });
      // No phase-2 transition, no shortlist logic — a late quote must not be
      // what starts quote collection.
      expect(prisma.rescueRequest.updateMany).not.toHaveBeenCalled();
      expect(row.quoteCollectionDeadline).toBeNull();
    });

    it('marks a quote arriving after bidding closed as NOT_SELECTED and says so', async () => {
      row.quoteCollectionDeadline = new Date(Date.now() - 1000); // deadline already passed
      const deadlineBefore = row.quoteCollectionDeadline;

      const result = await service.processQuoteOrDecline(offer, 2_500_000);

      expect(result.quoted).toBe(false);
      expect(result.message).toContain('Bidding has already closed');
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { id: 'offer-1', status: 'PENDING' },
        data: { status: 'NOT_SELECTED', quotedPrice: 2_500_000, respondedAt: expect.any(Date) },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1); // never claimed as QUOTED
      expect(row.quoteCollectionDeadline).toBe(deadlineBefore);
    });

    it('closes bidding EARLY when nothing is left pending — at t=40s, not at the 5-minute deadline', async () => {
      // The regression an earlier draft of the spec introduced. The deadline
      // is a ceiling on stragglers, never a floor on how fast the motorist
      // can be shown a shortlist.
      jest.useFakeTimers();
      try {
        const closeSpy = jest.spyOn(service as any, 'sendQuoteShortlist').mockResolvedValue(undefined);

        await service.processQuoteOrDecline(offer, 2_500_000); // t=0, deadline = t+5min
        expect(closeSpy).not.toHaveBeenCalled(); // one straggler still pending

        jest.advanceTimersByTime(40 * 1000);
        prisma.dispatchOffer.count.mockResolvedValue(0); // last outstanding offer just answered
        await service.processQuoteOrDecline({ ...offer, id: 'offer-3' }, 2_400_000);

        // t=40s: shortlist already out, without advancing to the deadline.
        expect(closeSpy).toHaveBeenCalledWith('req-1', 'cust-1');
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
          where: { rescueRequestId: 'req-1', status: 'PENDING' },
          data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
        });
        // ...and the close timer was cancelled rather than left to fire a
        // second shortlist at the deadline.
        expect((service as any).closeTimers.size).toBe(0);
        closeSpy.mockClear();
        jest.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('fires the close timer AT the deadline, not a full window after the countdown sends finish', async () => {
      // The countdown notice is N Twilio round-trips and is awaited before the
      // timer is scheduled. Scheduling `quoteCollectionMs` from that point
      // fires at deadline + notify-latency — the persisted deadline stays
      // correct but the motorist's shortlist goes out late.
      jest.useFakeTimers();
      try {
        const t0 = Date.now();
        prisma.dispatchOffer.findMany.mockResolvedValue([
          { operatorId: 'op-2', operator: { phoneNumber: '+2349022222222' } },
        ]);
        // Two seconds of WhatsApp latency, on the clock the timer is scheduled against.
        twilioService.sendWhatsAppMessage.mockImplementation(async () => {
          jest.advanceTimersByTime(2000);
        });
        const closeSpy = jest.spyOn(service as any, 'sendQuoteShortlist').mockResolvedValue(undefined);

        await service.processQuoteOrDecline(offer, 2_500_000);
        expect(row.quoteCollectionDeadline).toEqual(new Date(t0 + 5 * 60 * 1000));

        prisma.dispatchOffer.count.mockResolvedValue(2); // stragglers: only the timer can close this
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000 - 2000 - 1);
        expect(closeSpy).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1); // now exactly at the deadline
        expect(Date.now()).toBe(row.quoteCollectionDeadline!.getTime());
        expect(closeSpy).toHaveBeenCalledWith('req-1', 'cust-1');
      } finally {
        jest.useRealTimers();
      }
    });

    it('sends the countdown notice via the Content Template when the SID is set, freeform when it is not', async () => {
      jest.useFakeTimers();
      try {
        prisma.dispatchOffer.findMany.mockResolvedValue([
          { operatorId: 'op-2', operator: { phoneNumber: '+2349022222222' } },
        ]);

        process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID = 'HXcountdown1';
        await service.processQuoteOrDecline(offer, 2_500_000);

        expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
          expect.stringContaining('+2349022222222'),
          'HXcountdown1',
          { '1': expect.any(String), '2': '5 minutes' },
        );
        expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();

        const vars = twilioService.sendWhatsAppTemplateMessage.mock.calls[0][2];
        for (const value of Object.values(vars) as string[]) {
          expect(value).not.toMatch(/[\r\n\t]/);
          expect(value).not.toMatch(/ {4,}/);
          expect(value.length).toBeGreaterThan(0);
        }

        // Now the unset case, on a fresh request.
        delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
        row.quoteCollectionDeadline = null;
        twilioService.sendWhatsAppTemplateMessage.mockClear();
        await service.processQuoteOrDecline({ ...offer, id: 'offer-4' }, 2_500_000);

        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.stringContaining('+2349022222222'),
          expect.stringContaining('Countdown started'),
        );
        expect(twilioService.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a decline in phase 2 is claimed atomically and does not touch the deadline', async () => {
      jest.useFakeTimers();
      try {
        await service.processQuoteOrDecline(offer, 2_500_000);
        const deadline = row.quoteCollectionDeadline!;
        prisma.rescueRequest.updateMany.mockClear();

        const result = await service.processQuoteOrDecline({ ...offer, id: 'offer-5' }, undefined);

        expect(result.quoted).toBe(false);
        expect(result.message).toContain('declined');
        expect(prisma.rescueRequest.updateMany).not.toHaveBeenCalled();
        expect(row.quoteCollectionDeadline).toBe(deadline);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('expandRadiusNow', () => {
    let radiusService: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock; updateMany: jest.Mock };
      dispatchOffer: { updateMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn(), updateMany: jest.fn() },
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

    it('refuses once bidding has closed, even though the request is still DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        quoteCollectionDeadline: new Date(Date.now() - 1),
      });
      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow('Bidding has closed');
      expect(startDispatchSpy).not.toHaveBeenCalled();
    });

    it('refuses after an EARLY close, while the deadline is still in the future', async () => {
      // Everyone answered before the deadline, so the shortlist has already
      // gone out even though quoteCollectionDeadline still reads "in future".
      // Guarding on the deadline alone would let this Expand create a fresh
      // PENDING offer for a job the motorist is already choosing from.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        quoteCollectionDeadline: new Date(Date.now() + 4 * 60 * 1000),
      });
      (radiusService as any).closedRequests.add('req-1');
      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow('Bidding has closed');
      expect(startDispatchSpy).not.toHaveBeenCalled();
    });

    it('still works while bidding is open, and does not move the deadline', async () => {
      const deadline = new Date(Date.now() + 3 * 60 * 1000);
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        quoteCollectionDeadline: deadline,
      });
      sessionStore.getOrCreate.mockResolvedValue({ dispatchRound: 1 });
      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);

      await radiusService.expandRadiusNow('req-1');

      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1', 4);
      // The invariant: an admin adding operators never pushes the motorist's
      // deadline out. Nothing wrote to the request at all.
      expect(prisma.rescueRequest.updateMany).not.toHaveBeenCalled();
    });

    it('starts a new round with an expanded radius', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
      });
      sessionStore.getOrCreate.mockResolvedValue({ dispatchRound: 1 });

      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);

      await radiusService.expandRadiusNow('req-1');

      // round 1 → current radius approximated as 1 * RADIUS_EXPANSION_KM (2) = 2,
      // expanded by one more increment = 4
      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1', 4);
    });

    it('leaves offers that operators are still holding completely alone', async () => {
      // The regression this whole change exists for. Expanding used to call
      // supersedeActiveRound, which timed out every PENDING offer on the
      // request — an operator two minutes into a ten-minute window lost the
      // offer because an admin clicked Expand. Expanding adds people; it must
      // never un-ask anyone.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
      });
      sessionStore.getOrCreate.mockResolvedValue({ dispatchRound: 1 });
      jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);

      const liveBatchTimer = setTimeout(() => {}, 100000);
      const key = (radiusService as any).batchKey('req-1', 'batch-live');
      (radiusService as any).batchTimers.set(key, liveBatchTimer);

      await radiusService.expandRadiusNow('req-1');

      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
      // The in-flight batch's own timer is untouched, so it still resolves on
      // its own schedule rather than being cancelled by the expand.
      expect((radiusService as any).batchTimers.has(key)).toBe(true);

      clearTimeout(liveBatchTimer);
      (radiusService as any).batchTimers.delete(key);
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

    it('refuses once bidding has closed, even though the request is still DISPATCHING', async () => {
      // RescueRequest.status stays DISPATCHING after the shortlist goes out —
      // only the WhatsApp session moves on — so the deadline is what has to be
      // checked here.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
        quoteCollectionDeadline: new Date(Date.now() - 1000),
      });

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('Bidding has closed');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('refuses after an EARLY close, while the deadline is still in the future', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
        quoteCollectionDeadline: new Date(Date.now() + 4 * 60 * 1000),
      });
      (manualService as any).closedRequests.add('req-1');

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('Bidding has closed');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('clamps a phase-2 offer to the deadline and tells the operator the TRUE remaining time', async () => {
      jest.useFakeTimers();
      try {
        const deadline = new Date(Date.now() + 90 * 1000); // 90s left, not the 5-minute window
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
          vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
          quoteCollectionDeadline: deadline,
        });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

        await manualService.manualOfferToOperator('req-1', 'op-1');

        const created = prisma.dispatchOffer.create.mock.calls[0][0].data;
        expect(created.expiresAt.getTime()).toBe(deadline.getTime());
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('You have 90 seconds to respond'),
        );
        // The offer was clamped TO the deadline — it never moved it.
        expect(deadline.getTime()).toBe(Date.now() + 90 * 1000);

        clearAllBatchTimers(manualService);
      } finally {
        jest.useRealTimers();
      }
    });

    it('clamps even when the deadline is set AFTER the request was first read (the expand-vs-first-quote race)', async () => {
      jest.useFakeTimers();
      try {
        const deadline = new Date(Date.now() + 60 * 1000);
        // First read (the status guard) sees phase 1; by the time the offer is
        // written a quote has landed and phase 2 has begun.
        prisma.rescueRequest.findUnique
          .mockResolvedValueOnce({
            id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
            vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
            quoteCollectionDeadline: null,
          })
          .mockResolvedValue({ quoteCollectionDeadline: deadline });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

        await manualService.manualOfferToOperator('req-1', 'op-1');

        const created = prisma.dispatchOffer.create.mock.calls[0][0].data;
        expect(created.expiresAt.getTime()).toBe(deadline.getTime());
        expect(created.expiresAt.getTime()).toBeLessThan(Date.now() + 5 * 60 * 1000);

        clearAllBatchTimers(manualService);
      } finally {
        jest.useRealTimers();
      }
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
      // One timer, keyed to this batch rather than to the request.
      const keys = [...(manualService as any).batchTimers.keys()] as string[];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^req-1:[0-9a-f-]+$/);

      // Clean up the real timer this test scheduled
      clearTimeout((manualService as any).batchTimers.get(keys[0]));
    });

    it('adds its batch alongside an in-flight one instead of replacing it', async () => {
      // Previously this called supersedeActiveRound, which cancelled the
      // pending offers AND the existing timer so only one round was ever live.
      // Now both batches coexist, each resolving its own operator set on its
      // own schedule — which is only safe because the timers are keyed per
      // batch rather than per request.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      const priorTimer = setTimeout(() => {}, 100000);
      const priorKey = (manualService as any).batchKey('req-1', 'batch-prior');
      (manualService as any).batchTimers.set(priorKey, priorTimer);

      await manualService.manualOfferToOperator('req-1', 'op-1');

      // The in-flight batch survives untouched...
      expect((manualService as any).batchTimers.get(priorKey)).toBe(priorTimer);
      // ...and no offer was cancelled to make room for the new one.
      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();

      const keys = [...(manualService as any).batchTimers.keys()] as string[];
      expect(keys).toHaveLength(2);
      keys.forEach((k) => clearTimeout((manualService as any).batchTimers.get(k)));
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

        expect(resolveBatchSpy).toHaveBeenCalledWith('req-1', ['op-1'], 'cust-1', 2, expect.any(String));
      } finally {
        jest.useRealTimers();
        process.env.API_BASE_URL = prevApiBaseUrl;
      }
    });

    it('sends via the approved Content Template — matching its actual shape: no separate ETA slot, {{8}} repeats the job ref — when TWILIO_DISPATCH_OFFER_TEMPLATE_SID is set', async () => {
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
        {
          '1': expect.any(String),
          '2': 'Sedan',
          '3': 'Lekki',
          '4': 'Distance: N/A',
          '5': expect.any(String),
          '6': expect.any(String),
          '7': '5 minutes',
        },
      );
      // Exact-shape match above (not objectContaining) is deliberate: the
      // live template declares exactly 7 variables, and sending an extra
      // key fails the whole send with Twilio 21656.
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();

      clearAllBatchTimers(manualService);
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
      platformConfigService = { getConfig: jest.fn().mockResolvedValue({ dispatchWindowMinutes: 10, dispatchBatchSize: 3 }) };
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

    it('sizes the offered batch from PlatformConfig.dispatchBatchSize, not a hardcoded constant', async () => {
      platformConfigService.getConfig.mockResolvedValue({ dispatchWindowMinutes: 10, dispatchBatchSize: 1 });

      await batchService.startDispatch('req-1', 'cust-1');

      expect(prisma.dispatchOffer.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ operatorId: 'op-a' })],
      });

      clearAllBatchTimers(batchService);
    });

    it('sends via the Content Template, with per-operator distance+ETA combined into {{4}} (the template has no separate ETA slot), when TWILIO_DISPATCH_OFFER_TEMPLATE_SID is set', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349011111111'),
        'HXtest789',
        {
          '1': expect.any(String),
          '2': 'Sedan',
          '3': 'Lekki',
          '4': expect.stringMatching(/^Distance: 5\.2 km · Est\. ETA: ~\d+ min based on your registered location\.$/),
          '5': 'https://maps.google.com/?q=6.5,3.4',
          '6': expect.any(String),
          '7': '10 minutes',
        },
      );
      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        'HXtest789',
        expect.objectContaining({ '4': expect.stringContaining('Distance: 8.1 km') }),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();

      clearAllBatchTimers(batchService);
    });

    it('sends exactly the seven variables the live template declares — an extra key fails the whole send with Twilio 21656', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';

      await batchService.startDispatch('req-1', 'cust-1');

      const vars = twilioService.sendWhatsAppTemplateMessage.mock.calls[0][2];
      expect(Object.keys(vars).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);

      clearAllBatchTimers(batchService);
    });

    it('no variable contains a newline, tab, 4+ consecutive spaces, or is empty — all are Twilio 21656 triggers', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';
      const prevApiBaseUrl = process.env.API_BASE_URL;
      process.env.API_BASE_URL = 'https://api.example.com';
      try {
        // Multi-line values are the realistic case: address + map link, and
        // several media links, are what the live code actually produces.
        sharedService.formatLocationSection.mockResolvedValue(
          '4 Wilmot Point Rd, Victoria Island, Lagos\n📍 https://maps.google.com/?q=6.5,3.4',
        );
        prisma.requestMedia.findMany.mockResolvedValue([{ id: 'media-1' }, { id: 'media-2' }]);

        await batchService.startDispatch('req-1', 'cust-1');

        const vars = twilioService.sendWhatsAppTemplateMessage.mock.calls[0][2];
        for (const [key, value] of Object.entries(vars)) {
          expect(typeof value).toBe('string');
          expect(value as string).not.toMatch(/[\r\n\t]/);
          expect(value as string).not.toMatch(/ {4,}/);
          expect((value as string).length).toBeGreaterThan(0);
          expect(key).toMatch(/^[1-7]$/);
        }
        // Content survives flattening — both media links still present.
        expect(vars['6']).toContain('media-1');
        expect(vars['6']).toContain('media-2');

        clearAllBatchTimers(batchService);
      } finally {
        process.env.API_BASE_URL = prevApiBaseUrl;
      }
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

      clearAllBatchTimers(batchService);
    });
  });

  describe('resolveBatch — no-quotes continuation (Task 7)', () => {
    // Task 7: the DISPATCH_RETRY_MINUTES delayed retry is gone. A batch that
    // resolves with zero quotes must move to the next batch on the SAME
    // TICK (no setTimeout) — unless phase 2 has already started
    // (quoteCollectionDeadline set on the request), in which case this
    // automatic continuation must no-op and leave phase 2's own
    // closeBidding/deadline timer (Tasks 4-6) to own what happens next.
    let service: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { updateMany: jest.Mock; findMany: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        dispatchOffer: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn().mockResolvedValue([]), // no QUOTED offers — the no-quotes path
        },
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

      service = module.get<DispatchService>(DispatchService);
    });

    function seedBatchTimer(requestId: string, batchId: string) {
      const key = (service as any).batchKey(requestId, batchId);
      const timer = setTimeout(() => {}, 1_000_000); // never fires in the test
      (service as any).batchTimers.set(key, timer);
      return key;
    }

    it('phase 1 (no deadline set): calls startDispatch again immediately, with no setTimeout scheduled', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'DISPATCHING',
        quoteCollectionDeadline: null,
      });
      const startDispatchSpy = jest.spyOn(service, 'startDispatch').mockResolvedValue(undefined);
      seedBatchTimer('req-1', 'batch-1'); // pre-existing decoy timer, seeded BEFORE the spy below

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      await (service as any).resolveBatch('req-1', ['op-1'], 'cust-1', 2, 'batch-1');

      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1', 2);
      // resolveBatch itself must not schedule any new timer for a retry —
      // the old DISPATCH_RETRY_MINUTES setTimeout is gone; continuation
      // happens synchronously via the startDispatch call above.
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
    });

    it('phase 2 already active (quoteCollectionDeadline set): does NOT call startDispatch again', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        status: 'DISPATCHING',
        quoteCollectionDeadline: new Date(Date.now() + 5 * 60 * 1000),
      });
      const startDispatchSpy = jest.spyOn(service, 'startDispatch').mockResolvedValue(undefined);

      seedBatchTimer('req-1', 'batch-1');
      await (service as any).resolveBatch('req-1', ['op-1'], 'cust-1', 2, 'batch-1');

      expect(startDispatchSpy).not.toHaveBeenCalled();
    });
  });
});
