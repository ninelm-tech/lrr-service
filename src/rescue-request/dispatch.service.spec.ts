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

describe('DispatchService', () => {
  it('registers as a singleton — two module resolutions return the same batchTimers instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), RescueRequestModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const first = moduleRef.get(DispatchService);
    const second = moduleRef.get(DispatchService);
    expect(first).toBe(second);
  });

  describe('getDispatchBoard', () => {
    let boardService: DispatchService;
    let prisma: {
      rescueRequest: { findMany: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findMany: jest.fn() },
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
          dispatchRound: 2,
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

    it('surfaces quoteCollectionDeadline so the admin UI can gate Expand near bidding close', async () => {
      const deadline = new Date('2026-08-12T10:05:00Z');
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: null,
          destination: null,
          createdAt: new Date(),
          customerId: 'cust-1',
          dispatchRound: 0,
          dispatchOffers: [],
          quoteCollectionDeadline: deadline,
        },
      ]);

      const result = await boardService.getDispatchBoard();

      expect(result[0].quoteCollectionDeadline).toEqual(deadline);
    });

    it('reports each request’s own round, so one customer’s two requests do not share one', async () => {
      // Previously the round came from the customer's WhatsApp session, keyed
      // by customerId — so two concurrent requests from the same person were
      // shown the same round, whichever they were actually on.
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: null,
          destination: null,
          createdAt: new Date(),
          customerId: 'cust-1',
          dispatchRound: 0,
          dispatchOffers: [],
        },
        {
          id: 'req-2',
          status: 'DISPATCHING',
          vehicleType: null,
          destination: null,
          createdAt: new Date(),
          customerId: 'cust-1',
          dispatchRound: 3,
          dispatchOffers: [],
        },
      ]);

      const result = await boardService.getDispatchBoard();

      expect(result.map((r) => r.round)).toEqual([0, 3]);
    });
  });

  describe('batch identity survives the expiresAt rewrite', () => {
    it('maybeResolveBatchEarly still finds offers sharing a batchId even when one has a rewritten, shorter expiresAt', async () => {
      // Simulates Task 5's transition: an offer's expiresAt can be shortened
      // independently of the rest of its batch. Lookups must key off batchId,
      // never expiresAt, or a rewritten offer silently drops out of its batch.
      const prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1' }),
        },
        dispatchOffer: {
          findMany: jest.fn().mockResolvedValue([
            {
              operatorId: 'op-1',
              status: 'QUOTED',
              expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            },
            {
              operatorId: 'op-2',
              status: 'DECLINED',
              expiresAt: new Date(Date.now() + 60 * 1000),
            }, // rewritten shorter
          ]),
          updateMany: jest.fn(),
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

      await (service as any).maybeResolveBatchEarly('req-1', 'batch-shared');

      expect(prisma.dispatchOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rescueRequestId: 'req-1', batchId: 'batch-shared' },
        }),
      );
      // Everyone in the batch has answered, so its offers are expired now and
      // BatchResolveCheck picks them up on its next tick — rather than a
      // second code path resolving the batch itself and racing that check.
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rescueRequestId: 'req-1',
          batchId: 'batch-shared',
          expiresAt: { gt: expect.any(Date) },
        },
        data: { expiresAt: expect.any(Date) },
      });
    });
  });

  describe('processQuoteOrDecline — phase 2 (quote collection)', () => {
    let service: DispatchService;
    let prisma: any;
    let twilioService: {
      sendWhatsAppMessage: jest.Mock;
      sendWhatsAppTemplateMessage: jest.Mock;
    };
    /** Stand-in for the persisted RescueRequest row, mutated by updateMany. */
    let row: {
      id: string;
      status: string;
      customerId: string;
      quoteCollectionDeadline: Date | null;
    };
    const originalCountdownSid =
      process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;

    const offer = {
      id: 'offer-1',
      rescueRequestId: 'req-1',
      expiresAt: new Date(Date.now() + 600000),
      batchId: 'batch-1',
    };

    afterEach(() => {
      // No close timers to drain any more — bidding closes off
      // quoteCollectionDeadline, via BiddingCloseCheck.
      if (originalCountdownSid === undefined)
        delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
      else
        process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID = originalCountdownSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
      row = {
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        quoteCollectionDeadline: null,
      };

      prisma = {
        rescueRequest: {
          findUnique: jest.fn(async () => ({ ...row })),
          // Models the atomic once-only set: the `quoteCollectionDeadline: null`
          // condition is what stops a second quote moving the deadline.
          updateMany: jest.fn(async ({ where, data }: any) => {
            if (
              where.quoteCollectionDeadline === null &&
              row.quoteCollectionDeadline !== null
            ) {
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
      twilioService = {
        sendWhatsAppMessage: jest.fn(),
        sendWhatsAppTemplateMessage: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          {
            provide: PlatformConfigService,
            useValue: {
              getConfig: jest
                .fn()
                .mockResolvedValue({ quoteCollectionMinutes: 5 }),
            },
          },
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
        expect(row.quoteCollectionDeadline).toEqual(
          new Date(Date.now() + 5 * 60 * 1000),
        );
        expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
          where: { id: 'req-1', quoteCollectionDeadline: null },
          data: { quoteCollectionDeadline: row.quoteCollectionDeadline },
        });
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
          where: {
            rescueRequestId: 'req-1',
            status: 'PENDING',
            expiresAt: { gt: row.quoteCollectionDeadline },
          },
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
          { ...offer, id: 'offer-2', batchId: 'batch-1' },
          2_600_000,
        );

        expect(second.quoted).toBe(true);
        // THE invariant.
        expect(row.quoteCollectionDeadline).toBe(deadlineAfterFirst);
        // Only the atomic claim on the offer itself — no expiresAt rewrite,
        // no second countdown notice.
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: 'offer-2' }),
          }),
        );
        expect(prisma.dispatchOffer.findMany).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects an offer that is still PENDING but already past its expiresAt (the sweep-gap case)', async () => {
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.processQuoteOrDecline(offer, 2_500_000);

      expect(result).toEqual({
        quoted: false,
        message: 'Sorry, that offer has expired.',
      });
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
        data: {
          status: 'NOT_SELECTED',
          quotedPrice: 2_500_000,
          respondedAt: expect.any(Date),
        },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1); // never claimed as QUOTED
      expect(row.quoteCollectionDeadline).toBe(deadlineBefore);
    });

    it('closes bidding EARLY when nothing is left pending — by pulling the deadline forward, not waiting it out', async () => {
      // The deadline is a ceiling on stragglers, never a floor on how fast
      // the motorist can be shown a shortlist. Early close is now expressed
      // as making the row match BiddingCloseCheck immediately, rather than a
      // second code path that closes bidding itself and races that check.
      jest.useFakeTimers();
      try {
        await service.processQuoteOrDecline(offer, 2_500_000); // t=0, deadline = t+5min
        prisma.rescueRequest.updateMany.mockClear();

        jest.advanceTimersByTime(40 * 1000);
        prisma.dispatchOffer.count.mockResolvedValue(0); // last outstanding offer just answered
        await service.processQuoteOrDecline(
          { ...offer, id: 'offer-3' },
          2_400_000,
        );

        expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'req-1',
            status: 'DISPATCHING',
            biddingClosedAt: null,
            quoteCollectionDeadline: { gt: expect.any(Date) },
          },
          data: { quoteCollectionDeadline: expect.any(Date) },
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves the deadline alone while stragglers are still pending', async () => {
      jest.useFakeTimers();
      try {
        await service.processQuoteOrDecline(offer, 2_500_000);
        prisma.rescueRequest.updateMany.mockClear();

        prisma.dispatchOffer.count.mockResolvedValue(2); // stragglers
        await service.processQuoteOrDecline(
          { ...offer, id: 'offer-3' },
          2_400_000,
        );

        // Nothing pulled forward — the deadline remains the ceiling, and
        // BiddingCloseCheck closes when it passes. Asserted on the
        // early-close signature specifically: beginQuoteCollectionIfFirst
        // also calls updateMany, so a bare "not called" would be wrong.
        const pulledForward = prisma.rescueRequest.updateMany.mock.calls.some(
          ([args]: [{ where: Record<string, unknown> }]) =>
            'biddingClosedAt' in args.where,
        );
        expect(pulledForward).toBe(false);
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
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- not redundant: without it Object.values() yields unknown[] and .length fails to compile
        for (const value of Object.values(vars) as string[]) {
          expect(value).not.toMatch(/[\r\n\t]/);
          expect(value).not.toMatch(/ {4,}/);
          expect(value.length).toBeGreaterThan(0);
        }

        // Now the unset case, on a fresh request.
        delete process.env.TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID;
        row.quoteCollectionDeadline = null;
        twilioService.sendWhatsAppTemplateMessage.mockClear();
        await service.processQuoteOrDecline(
          { ...offer, id: 'offer-4' },
          2_500_000,
        );

        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.stringContaining('+2349022222222'),
          expect.stringContaining('Countdown started'),
        );
        expect(
          twilioService.sendWhatsAppTemplateMessage,
        ).not.toHaveBeenCalled();
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

        const result = await service.processQuoteOrDecline(
          { ...offer, id: 'offer-5' },
          undefined,
        );

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
      rescueRequest: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
        update: jest.Mock;
      };
      dispatchOffer: { updateMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest.fn(),
          updateMany: jest.fn(),
          update: jest.fn(),
        },
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
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'OPERATOR_ASSIGNED',
      });

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow(
        'not currently DISPATCHING',
      );
    });

    it('refuses once bidding has closed, even though the request is still DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        quoteCollectionDeadline: new Date(Date.now() - 1),
      });
      const startDispatchSpy = jest
        .spyOn(radiusService as any, 'startDispatch')
        .mockResolvedValue(undefined);

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow(
        'Bidding has closed',
      );
      expect(startDispatchSpy).not.toHaveBeenCalled();
    });

    it('refuses after an EARLY close, while the deadline is still in the future', async () => {
      // Everyone answered before the deadline, so the shortlist has already
      // gone out even though quoteCollectionDeadline still reads "in future".
      // Guarding on the deadline alone would let this Expand create a fresh
      // PENDING offer for a job the motorist is already choosing from.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        quoteCollectionDeadline: new Date(Date.now() + 4 * 60 * 1000),
        // Durable, unlike the in-memory Set this replaces: a restart used to
        // forget the close and let an Expand reopen a decided auction.
        biddingClosedAt: new Date(),
      });
      const startDispatchSpy = jest
        .spyOn(radiusService as any, 'startDispatch')
        .mockResolvedValue(undefined);

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow(
        'Bidding has closed',
      );
      expect(startDispatchSpy).not.toHaveBeenCalled();
    });

    it('still works while bidding is open, and does not move the deadline', async () => {
      const deadline = new Date(Date.now() + 3 * 60 * 1000);
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        quoteCollectionDeadline: deadline,
        dispatchRound: 1,
      });
      const startDispatchSpy = jest
        .spyOn(radiusService as any, 'startDispatch')
        .mockResolvedValue(undefined);

      await radiusService.expandRadiusNow('req-1');

      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1');
      // The invariant: an admin adding operators never pushes the motorist's
      // deadline out. The round advances (that IS the expansion), but the
      // deadline is untouched.
      expect(prisma.rescueRequest.updateMany).not.toHaveBeenCalled();
      const [[updateArgs]] = prisma.rescueRequest.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(Object.keys(updateArgs.data)).toEqual(['dispatchRound']);
    });

    it('starts a new round with an expanded radius', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        dispatchRound: 1,
      });

      const startDispatchSpy = jest
        .spyOn(radiusService as any, 'startDispatch')
        .mockResolvedValue(undefined);

      await radiusService.expandRadiusNow('req-1');

      // Advancing the round IS the expansion: prepareNextRound derives the
      // radius from it, so there is no separate radius argument to get out
      // of step with the persisted round.
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { dispatchRound: 2 },
      });
      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1');
    });

    it('leaves offers that operators are still holding completely alone', async () => {
      // The regression this whole change exists for. Expanding used to call
      // supersedeActiveRound, which timed out every PENDING offer on the
      // request — an operator two minutes into a ten-minute window lost the
      // offer because an admin clicked Expand. Expanding adds people; it must
      // never un-ask anyone.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        dispatchRound: 1,
      });
      jest
        .spyOn(radiusService as any, 'startDispatch')
        .mockResolvedValue(undefined);

      await radiusService.expandRadiusNow('req-1');

      // No offer is touched at all. In-flight batches keep their own
      // expiresAt and resolve on their own schedule via BatchResolveCheck —
      // there is no timer for an expand to cancel any more.
      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('manualOfferToOperator', () => {
    let manualService: DispatchService;
    let prisma: {
      rescueRequest: {
        findUnique: jest.Mock;
        findUniqueOrThrow: jest.Mock;
        update: jest.Mock;
      };
      operator: { findUnique: jest.Mock };
      dispatchOffer: { create: jest.Mock; updateMany: jest.Mock };
      requestMedia: { findMany: jest.Mock };
      $transaction: jest.Mock;
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let twilioService: {
      sendWhatsAppMessage: jest.Mock;
      sendWhatsAppTemplateMessage: jest.Mock;
    };
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      prisma = {
        rescueRequest: {
          findUnique: jest.fn(),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ dispatchRound: 1 }),
          update: jest.fn(),
        },
        operator: { findUnique: jest.fn() },
        dispatchOffer: { create: jest.fn(), updateMany: jest.fn() },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
        // The offer and the offeredOperatorIds append now commit together, so
        // the callback runs against this same mock as its transaction client.
        $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      };
      twilioService = {
        sendWhatsAppMessage: jest.fn(),
        sendWhatsAppTemplateMessage: jest.fn(),
      };
      sharedService = {
        formatLocationSection: jest
          .fn()
          .mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
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
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'OPERATOR_ASSIGNED',
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('not currently DISPATCHING');
    });

    it('refuses once bidding has closed, even though the request is still DISPATCHING', async () => {
      // RescueRequest.status stays DISPATCHING after the shortlist goes out —
      // only the WhatsApp session moves on — so the deadline is what has to be
      // checked here.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        quoteCollectionDeadline: new Date(Date.now() - 1000),
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('Bidding has closed');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('refuses after an EARLY close, while the deadline is still in the future', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        quoteCollectionDeadline: new Date(Date.now() + 4 * 60 * 1000),
        biddingClosedAt: new Date(),
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('Bidding has closed');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('refuses when bidding closes DURING the method — after the top-of-method guard passes but before the create', async () => {
      // Simulates the exact gap the review flagged: the initial
      // assertBiddingStillOpen call (right after the first findUnique) sees
      // bidding still open, but BiddingCloseCheck stamps biddingClosedAt
      // (e.g. the last outstanding offer on this request gets answered)
      // while the awaited operator lookup is in flight — before
      // dispatchOffer.create runs. The pre-create guard re-reads, so it sees
      // a close that landed after the first read.
      const open = {
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        quoteCollectionDeadline: new Date(Date.now() + 4 * 60 * 1000),
        biddingClosedAt: null as Date | null,
      };
      prisma.rescueRequest.findUnique.mockImplementation(() =>
        Promise.resolve({ ...open }),
      );
      prisma.operator.findUnique.mockImplementation(async () => {
        open.biddingClosedAt = new Date(); // closes mid-method
        return {
          id: 'op-1',
          status: 'ACTIVE',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
        };
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('Bidding has closed');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('clamps a phase-2 offer to the deadline and tells the operator the TRUE remaining time', async () => {
      jest.useFakeTimers();
      try {
        const deadline = new Date(Date.now() + 90 * 1000); // 90s left, not the 5-minute window
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1',
          status: 'DISPATCHING',
          customerId: 'cust-1',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          latitude: 6.5,
          longitude: 3.4,
          quoteCollectionDeadline: deadline,
        });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1',
          status: 'ACTIVE',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

        await manualService.manualOfferToOperator('req-1', 'op-1');

        const created = prisma.dispatchOffer.create.mock.calls[0][0].data;
        expect(created.expiresAt.getTime()).toBe(deadline.getTime());
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          // 90s rounds UP to 2 minutes — messages are minutes-only, no seconds.
          expect.stringContaining('You have 2 minutes to respond'),
        );
        // The offer was clamped TO the deadline — it never moved it.
        expect(deadline.getTime()).toBe(Date.now() + 90 * 1000);
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
            id: 'req-1',
            status: 'DISPATCHING',
            customerId: 'cust-1',
            vehicleType: 'SEDAN',
            destination: 'Lekki',
            latitude: 6.5,
            longitude: 3.4,
            quoteCollectionDeadline: null,
          })
          .mockResolvedValue({ quoteCollectionDeadline: deadline });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1',
          status: 'ACTIVE',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

        await manualService.manualOfferToOperator('req-1', 'op-1');

        const created = prisma.dispatchOffer.create.mock.calls[0][0].data;
        expect(created.expiresAt.getTime()).toBe(deadline.getTime());
        expect(created.expiresAt.getTime()).toBeLessThan(
          Date.now() + 5 * 60 * 1000,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects a missing or inactive operator', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'INACTIVE',
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('not an active operator');
    });

    it('creates a single-operator round: offer created and recorded in one transaction, WhatsApp sent', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
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
      // Appended on the REQUEST, with `push` rather than a read-modify-write:
      // an automatic round appending at the same moment must not drop this
      // operator, or the admin's pick gets offered the same job twice.
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { offeredOperatorIds: { push: ['op-1'] } },
      });
      // And it commits with the offer, not after it.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('includes the issue type in the freeform message when the request has one', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        issueType: 'FLAT_TYRE',
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Issue: Flat Tyre'),
      );
    });

    it('adds its batch alongside an in-flight one instead of replacing it', async () => {
      // Previously this called supersedeActiveRound, which cancelled the
      // pending offers so only one round was ever live. Now both batches
      // coexist, each resolving its own operator set on its own schedule —
      // safe because each offer carries its own expiresAt and batchId, and
      // BatchResolveCheck groups by batch.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      // No offer was cancelled to make room for the new one — the in-flight
      // batch keeps its own expiry and resolves on its own schedule.
      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
      expect(prisma.dispatchOffer.create).toHaveBeenCalledTimes(1);
    });

    it('arms no timer for the offer window, and includes media links in the message', async () => {
      jest.useFakeTimers();
      const prevApiBaseUrl = process.env.API_BASE_URL;
      process.env.API_BASE_URL = 'https://api.example.com';
      try {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          id: 'req-1',
          status: 'DISPATCHING',
          customerId: 'cust-1',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          latitude: 6.5,
          longitude: 3.4,
          // round 1 → accumulated radius of 1 * RADIUS_EXPANSION_KM (2)
          dispatchRound: 1,
        });
        prisma.operator.findUnique.mockResolvedValue({
          id: 'op-1',
          status: 'ACTIVE',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
        });
        prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
        prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });
        prisma.requestMedia.findMany.mockResolvedValue([{ id: 'media-1' }]);
        // session.dispatchRound is 1 → currentRadius should be 1 * RADIUS_EXPANSION_KM (2), not 0
        sessionStore.getOrCreate.mockResolvedValue({
          offeredOperatorIds: [],
          dispatchRound: 1,
        });

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

        await manualService.manualOfferToOperator('req-1', 'op-1');

        expect(prisma.requestMedia.findMany).toHaveBeenCalledWith({
          where: { rescueRequestId: 'req-1' },
        });
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('media-1'),
        );

        // No timer is armed at all: the offer's own expiresAt is what
        // BatchResolveCheck matches on, so this survives a restart.
        jest.advanceTimersByTime(5 * 60 * 1000);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
        process.env.API_BASE_URL = prevApiBaseUrl;
      }
    });

    it('sends via the approved Content Template — matching its actual shape: no separate ETA slot, {{8}} repeats the job ref — when TWILIO_DISPATCH_OFFER_TEMPLATE_SID is set', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest456';
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
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
    });

    it('logs to Sentry and re-throws (does not silently succeed) when the send fails', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });
      twilioService.sendWhatsAppMessage.mockRejectedValue(
        new Error('63016: outside messaging window'),
      );

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow('63016');
    });
  });

  describe('startDispatch — batch operator notification', () => {
    let batchService: DispatchService;
    let prisma: {
      rescueRequest: {
        findUnique: jest.Mock;
        findUniqueOrThrow: jest.Mock;
        update: jest.Mock;
      };
      user: { findUnique: jest.Mock };
      operator: { count: jest.Mock };
      dispatchOffer: {
        createMany: jest.Mock;
        count: jest.Mock;
        updateMany: jest.Mock;
      };
      requestMedia: { findMany: jest.Mock };
      whatsAppSession: { updateMany: jest.Mock };
      $transaction: jest.Mock;
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let operatorService: { findAndRankCandidates: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let twilioService: {
      sendWhatsAppMessage: jest.Mock;
      sendWhatsAppTemplateMessage: jest.Mock;
    };
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    const candidateA = {
      id: 'op-a',
      businessName: 'A Towing',
      phoneNumber: '+2349011111111',
      distance: 5.2,
    };
    const candidateB = {
      id: 'op-b',
      businessName: 'B Towing',
      phoneNumber: '+2349022222222',
      distance: 8.1,
    };

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            status: 'DISPATCHING',
            vehicleType: 'SEDAN',
            destination: 'Lekki',
            latitude: 6.5,
            longitude: 3.4,
            // Dispatch progression is read from the request now, not the session.
            dispatchRound: 0,
            offeredOperatorIds: [],
            quoteCollectionDeadline: null,
            biddingClosedAt: null,
          }),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ quoteCollectionDeadline: null }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ phoneNumber: '+2348000000000' }),
        },
        operator: { count: jest.fn() },
        dispatchOffer: {
          createMany: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
          updateMany: jest.fn(),
        },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
        whatsAppSession: { updateMany: jest.fn() },
        // Offers and the offeredOperatorIds append commit together now, so
        // the callback runs against this same mock as its transaction client.
        $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({}),
        update: jest.fn(),
      };
      operatorService = {
        findAndRankCandidates: jest
          .fn()
          .mockResolvedValue([candidateA, candidateB]),
      };
      platformConfigService = {
        getConfig: jest.fn().mockResolvedValue({
          dispatchWindowMinutes: 10,
          dispatchBatchSize: 3,
        }),
      };
      twilioService = {
        sendWhatsAppMessage: jest.fn(),
        sendWhatsAppTemplateMessage: jest.fn(),
      };
      sharedService = {
        formatLocationSection: jest
          .fn()
          .mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      };

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
      platformConfigService.getConfig.mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 1,
      });

      await batchService.startDispatch('req-1', 'cust-1');

      expect(prisma.dispatchOffer.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ operatorId: 'op-a' })],
      });
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
          '4': expect.stringMatching(
            /^Distance: 5\.2 km · Est\. ETA: ~\d+ min based on your registered location\.$/,
          ),
          '5': 'https://maps.google.com/?q=6.5,3.4',
          '6': expect.any(String),
          '7': '10 minutes',
        },
      );
      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        'HXtest789',
        expect.objectContaining({
          '4': expect.stringContaining('Distance: 8.1 km'),
        }),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('sends exactly the seven variables the live template declares — an extra key fails the whole send with Twilio 21656', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';

      await batchService.startDispatch('req-1', 'cust-1');

      const vars = twilioService.sendWhatsAppTemplateMessage.mock.calls[0][2];
      expect(Object.keys(vars).sort()).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
      ]);
    });

    it('still sends exactly seven template variables even when the request has an issueType — issueLine must not leak into the template path until the Content Template itself declares an 8th slot', async () => {
      process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = 'HXtest789';
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        dispatchRound: 0,
        offeredOperatorIds: [],
        quoteCollectionDeadline: null,
        biddingClosedAt: null,
        issueType: 'FLAT_TYRE',
      });

      await batchService.startDispatch('req-1', 'cust-1');

      const vars = twilioService.sendWhatsAppTemplateMessage.mock.calls[0][2];
      expect(Object.keys(vars).sort()).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
      ]);
    });

    it('includes the issue type in the freeform message when the request has one', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
        dispatchRound: 0,
        offeredOperatorIds: [],
        quoteCollectionDeadline: null,
        biddingClosedAt: null,
        issueType: 'FLAT_TYRE',
      });

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Issue: Flat Tyre'),
      );
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
        prisma.requestMedia.findMany.mockResolvedValue([
          { id: 'media-1' },
          { id: 'media-2' },
        ]);

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
      } finally {
        process.env.API_BASE_URL = prevApiBaseUrl;
      }
    });

    it('one operator send failing does not block the others in the batch, and is reported instead of thrown', async () => {
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to.includes('+2349011111111'))
          return Promise.reject(new Error('63016: outside messaging window'));
        return Promise.resolve();
      });

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // both attempted
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        expect.any(String),
      ); // the other operator still got theirs
    });

    it('sends the shortlist instead of auto-cancelling when candidates run out but a quote already exists — LRR-SERVICE-5', async () => {
      // Confirmed on staging: an admin clicking Expand on a request that
      // already had 2 valid QUOTED offers auto-cancelled it after 4 rounds,
      // because expandRadiusNow calls startDispatch directly and the
      // no-candidates branch had no idea a quote already existed —
      // resolveBatch's equivalent guard only protects its own tail call,
      // not this one.
      operatorService.findAndRankCandidates.mockResolvedValue([]); // nobody left to offer
      prisma.operator.count.mockResolvedValue(5); // operators exist nearby — not a coverage gap
      // The quote guard runs before any transaction, off this count.
      (prisma as any).dispatchOffer.count = jest.fn().mockResolvedValue(2);
      (prisma as any).dispatchOffer.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'offer-1', status: 'QUOTED' }]);
      (prisma as any).rescueRequest.update = jest.fn();
      (prisma as any).rescueRequest.findUnique = jest.fn().mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        dispatchRound: 3,
        offeredOperatorIds: ['op-a', 'op-b'],
        quoteCollectionDeadline: null,
        biddingClosedAt: null,
      });
      const shortlistSpy = jest
        .spyOn(batchService, 'deliverQuoteShortlist')
        .mockResolvedValue(undefined);

      await batchService.startDispatch('req-1', 'cust-1');

      expect(shortlistSpy).toHaveBeenCalledWith('req-1', 'cust-1');
      expect((prisma as any).rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('automatically cancelled'),
      );
    });
  });

  describe('deliverQuoteShortlist', () => {
    let service: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };
    let operatorService: { calculateDistance: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let sessionStore: { update: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            status: 'DISPATCHING',
            latitude: 6.5,
            longitude: 3.4,
            customer: { phoneNumber: '+2348000000000' },
          }),
        },
        dispatchOffer: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'offer-1',
              operatorId: 'op-1',
              quotedPrice: 1000000,
              operator: {
                businessName: 'Acme Towing',
                latitude: 6.5,
                longitude: 3.4,
              },
            },
          ]),
        },
      };
      operatorService = { calculateDistance: jest.fn().mockReturnValue(0) };
      platformConfigService = {
        getConfig: jest.fn().mockResolvedValue({ serviceFeePercent: 10 }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      sessionStore = { update: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: operatorService },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('leads the message with the 5-minute countdown, derived from QUOTE_SELECTION_WINDOW_MS', async () => {
      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348000000000',
        '🚗 *Operator quotes received!*\n⏰ You have 5 minutes to choose before this request is cancelled.\n\n1️⃣ ₦11,000 · ETA 0 min · Acme Towing\n\n⚠️ *ACTION NEEDED* — reply with the number of your choice (e.g. "1") to select an operator.',
      );
    });

    it('does not send anything when the request is no longer DISPATCHING (e.g. already cancelled) — closes the race where a stale QUOTED offer outlives a cancellation', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'CANCELLED',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2348000000000' },
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(prisma.dispatchOffer.findMany).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });
  });
});
