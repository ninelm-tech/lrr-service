import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { DispatchService } from './dispatch.service';
import { RescueRequestModule } from './rescue-request.module';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { ConfigModule } from '@nestjs/config';
import { OperatorMembershipService } from '../operator/operator-membership.service';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setLevel: jest.fn(), setContext: jest.fn() }),
  logger: { info: jest.fn() },
}));

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
          { provide: OperatorMembershipService, useValue: {} },
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

    it('surfaces needsManualAssignment so the Dispatch Board can badge a job stuck waiting on staff', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: null,
          destination: null,
          createdAt: new Date(),
          customerId: 'cust-1',
          dispatchRound: 3,
          dispatchOffers: [],
          needsManualAssignment: true,
        },
      ]);

      const result = await boardService.getDispatchBoard();

      expect(result[0].needsManualAssignment).toBe(true);
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
          { provide: OperatorMembershipService, useValue: {} },
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
      operatorId: 'op-1',
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
        $transaction: jest.fn((callback) => callback(prisma)),
        operator: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
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
          { provide: OperatorMembershipService, useValue: {} },
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
          {
            operatorId: 'op-2',
            operator: {
              phoneNumber: '+2349022222222',
              whatsappEnabled: true,
            },
          },
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

    it('does not warn a non-WhatsApp operator whose offer is still pending', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- prisma is typed `any` in this describe block's shared mock setup, same as every other prisma.* call above in this file; not a new unsafety, one more occurrence of the existing one.
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          operatorId: 'op-2',
          operator: {
            phoneNumber: '+2349022222222',
            whatsappEnabled: false,
          },
        },
      ]);

      await service.processQuoteOrDecline(offer, 2_500_000);

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
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

    it('does not claim through the public WhatsApp path when the operator was deleted', async () => {
      prisma.operator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.processQuoteOrDecline(offer, 2_500_000),
      ).rejects.toThrow('This operator is no longer available.');

      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('respondToOffer deletion lock', () => {
    it('locks active membership before claiming a dashboard offer', async () => {
      const prisma: any = {
        operatorMember: {
          findMany: jest.fn().mockResolvedValue([{ operatorId: 'op-1' }]),
        },
        dispatchOffer: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'offer-1',
            operatorId: 'op-1',
            rescueRequestId: 'req-1',
            batchId: 'batch-1',
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 60_000),
          }),
          updateMany: jest.fn(),
        },
      };
      prisma.$transaction = jest.fn((callback) => callback(prisma));
      const operatorMembershipService = {
        lockActiveMembership: jest
          .fn()
          .mockRejectedValue(new Error('This operator has been deleted.')),
      };
      const module = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          {
            provide: OperatorMembershipService,
            useValue: operatorMembershipService,
          },
        ],
      }).compile();
      const service = module.get(DispatchService);

      await expect(
        service.respondToOffer('user-1', 'offer-1', 2_500_000),
      ).rejects.toThrow('This operator has been deleted.');

      expect(
        operatorMembershipService.lockActiveMembership,
      ).toHaveBeenCalledWith(
        prisma,
        { userId: 'user-1', role: 'OPERATOR' },
        'op-1',
      );
      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
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
          { provide: OperatorMembershipService, useValue: {} },
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
      dispatchOffer: {
        create: jest.Mock;
        update: jest.Mock;
        updateMany: jest.Mock;
      };
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
    const originalApiBaseUrl = process.env.API_BASE_URL;

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
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
        dispatchOffer: {
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
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
        sendWhatsAppMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_manual_default' }),
        sendWhatsAppTemplateMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_manual_default' }),
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
          { provide: OperatorMembershipService, useValue: {} },
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
          whatsappEnabled: true,
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
          whatsappEnabled: true,
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
          whatsappEnabled: true,
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

    it('rejects offering a job to a non-WhatsApp operator — use assignOperator instead', async () => {
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
        whatsappEnabled: false,
        phoneNumber: '+2348011111111',
      });

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).rejects.toThrow(
        'This operator has no WhatsApp on file — use "Assign this operator" instead of offering.',
      );
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
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
        whatsappEnabled: true,
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

    it("persists the Twilio SID onto the manually-created offer's own row", async () => {
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
        whatsappEnabled: true,
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-manual-1' });
      twilioService.sendWhatsAppMessage.mockResolvedValue({
        sid: 'SM-manual-1',
      });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-manual-1' },
        data: { twilioMessageSid: 'SM-manual-1' },
      });
    });

    it('does not throw when persisting the Twilio SID fails — the message already sent, the admin must still see success', async () => {
      // Multi-llm review flagged the nesting here: the SID-persist
      // try/catch sits INSIDE the send's try/catch, whose own catch
      // re-throws. Today the inner catch doesn't re-throw, so this
      // already passes — but the structure makes that one accidental
      // line away from turning a persist-only failure into a reported
      // send failure. Locking in the correct behavior with a test, not
      // just a comment, and restructuring so it can't regress by nesting.
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
        whatsappEnabled: true,
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-manual-1' });
      twilioService.sendWhatsAppMessage.mockResolvedValue({
        sid: 'SM-manual-1',
      });
      prisma.dispatchOffer.update.mockRejectedValue(new Error('db down'));

      await expect(
        manualService.manualOfferToOperator('req-1', 'op-1'),
      ).resolves.toBeUndefined();

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ offerId: 'offer-manual-1' }),
        }),
      );
    });

    it('includes the offerId query param on the statusCallback URL for a manual offer', async () => {
      process.env.API_BASE_URL = 'https://api.example.com';
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
        whatsappEnabled: true,
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-manual-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-manual-1',
        },
      );
      // Restored by this block's afterEach, not inline here — an assertion
      // throwing above would otherwise leave API_BASE_URL set for later
      // tests.
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
        whatsappEnabled: true,
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
        whatsappEnabled: true,
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
          whatsappEnabled: true,
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
        // 3rd arg (statusCallback) is incidental here — this test sets
        // API_BASE_URL only to exercise media-link URL building, not to
        // test statusCallback construction (see the dedicated offerId
        // test above for that) — so it's deliberately not asserted on.
        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('media-1'),
          expect.any(Object),
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
        whatsappEnabled: true,
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
        whatsappEnabled: true,
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
        findMany: jest.Mock;
        count: jest.Mock;
        update: jest.Mock;
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
    const originalApiBaseUrl = process.env.API_BASE_URL;

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
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
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
            customer: { phoneNumber: '+2348000000000' },
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
          createMany: jest.fn<unknown, [{ data: { operatorId: string }[] }]>(),
          // Returns one row per distinct operatorId createMany was last
          // called with, so writeRound's offerId lookup always resolves —
          // the synthetic id just needs to be stable per operator, not
          // globally unique, for these tests.
          findMany: jest.fn().mockImplementation(() => {
            // createMany is declared as a bare jest.Mock in this block's
            // own `let prisma: {...}` type above (matching every other
            // mock in this file), so .mock.calls is untyped — the cast
            // is this file's established way of narrowing a Jest mock
            // call's recorded arguments back to a known shape (see the
            // identical pattern on prisma.rescueRequest.update.mock.calls
            // elsewhere in this file).
            const calls = prisma.dispatchOffer.createMany.mock.calls as [
              { data: { operatorId: string }[] },
            ][];
            const lastCall = calls.at(-1)?.[0];
            const operatorIds: string[] = (lastCall?.data ?? []).map(
              (d) => d.operatorId,
            );
            return Promise.resolve(
              operatorIds.map((operatorId) => ({
                id: `offer-${operatorId}`,
                operatorId,
              })),
            );
          }),
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn(),
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
          testCustomerPhoneNumbers: [],
        }),
      };
      twilioService = {
        sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM_default' }),
        sendWhatsAppTemplateMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_default' }),
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
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      batchService = module.get<DispatchService>(DispatchService);
    });

    it("passes isTest: true to findAndRankCandidates when the request's customer is on PlatformConfig.testCustomerPhoneNumbers", async () => {
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
        customer: { phoneNumber: '+2348012345678' },
      });
      platformConfigService.getConfig.mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        testCustomerPhoneNumbers: ['+2348012345678'],
      });

      await batchService.startDispatch('req-1', 'cust-1');

      expect(operatorService.findAndRankCandidates).toHaveBeenCalledWith(
        6.5,
        3.4,
        [],
        0,
        undefined,
        ['LIGHT_DUTY', 'TEN_TYRE'],
        true,
      );
    });

    it("passes isTest: false when the request's customer is not on the test list", async () => {
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
        customer: { phoneNumber: '+2348099999999' },
      });
      platformConfigService.getConfig.mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        testCustomerPhoneNumbers: ['+2348012345678'],
      });

      await batchService.startDispatch('req-1', 'cust-1');

      expect(operatorService.findAndRankCandidates).toHaveBeenCalledWith(
        6.5,
        3.4,
        [],
        0,
        undefined,
        ['LIGHT_DUTY', 'TEN_TYRE'],
        false,
      );
    });

    it('clears a stale needsManualAssignment flag the moment automatic dispatch finds candidates again', async () => {
      await batchService.startDispatch('req-1', 'cust-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { needsManualAssignment: false },
      });
    });

    it("threads prepareNextRound's extraRadiusKm and isTestRequest into resolveExhaustion's own fallback search when automatic dispatch is fully exhausted", async () => {
      // No candidates at any radius, and no coverage at all — resolveExhaustion's
      // own fallback search (which this test observes) must still receive the
      // same extraRadiusKm (0, since this exhausts on round 1 before any
      // expansion) and the same isTestRequest this round already computed.
      operatorService.findAndRankCandidates.mockResolvedValue([]);
      prisma.operator.count.mockResolvedValue(0);
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
        customer: { phoneNumber: '+2348012345678' },
      });
      platformConfigService.getConfig.mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        testCustomerPhoneNumbers: ['+2348012345678'],
      });

      await batchService.startDispatch('req-1', 'cust-1');

      // Call 1: prepareNextRound's own primary search (asserted elsewhere).
      // Call 2: resolveExhaustion's fallback search — same extraRadiusKm (0)
      // and isTestRequest (true) prepareNextRound itself computed.
      expect(operatorService.findAndRankCandidates).toHaveBeenNthCalledWith(
        2,
        6.5,
        3.4,
        [],
        0,
        undefined,
        ['LIGHT_DUTY', 'TEN_TYRE'],
        true,
        false,
      );
    });

    it('sizes the offered batch from PlatformConfig.dispatchBatchSize, not a hardcoded constant', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 1,
        testCustomerPhoneNumbers: [],
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
        customer: { phoneNumber: '+2348000000000' },
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
        customer: { phoneNumber: '+2348000000000' },
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
        return Promise.resolve({ sid: 'SM_ok' });
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

    it("persists the Twilio SID onto each offer's own row once its send resolves", async () => {
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) =>
        Promise.resolve({
          sid: to.includes('+2349011111111') ? 'SM-op-a' : 'SM-op-b',
        }),
      );

      await batchService.startDispatch('req-1', 'cust-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-a' },
        data: { twilioMessageSid: 'SM-op-a' },
      });
      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-b' },
        data: { twilioMessageSid: 'SM-op-b' },
      });
    });

    it('persisting the SID for one offer failing does not block persisting it for the others', async () => {
      prisma.dispatchOffer.update.mockImplementation(
        (args: { where: { id: string } }) => {
          if (args.where.id === 'offer-op-a')
            return Promise.reject(new Error('db down'));
          return Promise.resolve();
        },
      );

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-b' },
        data: { twilioMessageSid: 'SM_default' },
      });
    });

    it('throws a clear error instead of silently mis-attributing an offerId when fewer offers come back from the DB than the batch sent in', async () => {
      // Multi-llm review flagged the non-null assertion on
      // offerIdByOperatorId.get(op.id) as relying entirely on an
      // unenforced invariant (every batch entry produces exactly one
      // created row). This proves the mismatch fails loudly — at the
      // point it's discovered, with both counts in the message — rather
      // than one operator silently getting `offerId: undefined` (or,
      // post-`!`, a misleading "Cannot read properties of undefined").
      prisma.dispatchOffer.findMany.mockResolvedValue([
        { id: 'offer-op-a', operatorId: 'op-a' },
        // op-b's row is missing — simulates a duplicate operatorId in the
        // batch, or any other createMany/findMany divergence.
      ]);

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).rejects.toThrow(/expected 2 created offers, found 1/);
    });

    it("includes a statusCallback URL built from API_BASE_URL, the /api/v1 global prefix, and this offer's own id", async () => {
      // /api/v1 matters: main.ts calls app.setGlobalPrefix('api/v1'), so
      // every route — including this webhook — is actually served under
      // it. A URL missing this prefix 404s in production; this test is
      // what catches that regression before it ships again.
      process.env.API_BASE_URL = 'https://api.example.com';

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349011111111'),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-op-a',
        },
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-op-b',
        },
      );
    });

    it('strips a trailing slash from API_BASE_URL so the callback URL never contains a double slash — must stay byte-identical to what webhooks.controller.ts reconstructs for signature verification', async () => {
      process.env.API_BASE_URL = 'https://api.example.com/';

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349011111111'),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-op-a',
        },
      );
    });

    it('sends successfully with no statusCallback argument at all when API_BASE_URL is unset', async () => {
      // Deliberately a 2-arg call, not a 3-arg call with an explicit
      // `undefined` third argument — see this task's Step 5 design note on
      // why the third argument is conditionally omitted rather than always
      // passed. A 3-arg assertion here would also silently diverge from
      // every pre-existing 2-arg assertion elsewhere in this file for the
      // exact same mock, which multi-llm review caught as a real breakage.
      delete process.env.API_BASE_URL;

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
      );
    });
  });

  describe('deliverQuoteShortlist', () => {
    let service: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock; update: jest.Mock };
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
                depositPercentOverride: null,
              },
            },
          ]),
          update: jest.fn(),
        },
      };
      operatorService = { calculateDistance: jest.fn().mockReturnValue(0) };
      platformConfigService = {
        getConfig: jest
          .fn()
          .mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 }),
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
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('leads the message with the 5-minute countdown, derived from QUOTE_SELECTION_WINDOW_MS', async () => {
      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348000000000',
        '🚗 *Operator quotes received!*\n⏰ You have 5 minutes to choose before this request is cancelled.\n\n1️⃣ ₦11,000 · ETA 0 min · Deposit ₦1,100 · Acme Towing\n\n⚠️ *ACTION NEEDED* — reply with the number of your choice (e.g. "1") to select an operator.',
      );
    });

    it('delivers the shortlist to the BSUID when the customer has no visible phone number — otherwise they never see their quotes at all (Task 14, hotfix 2026-10-25)', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: null, whatsappExternalUserId: 'CA.masked' },
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:CA.masked',
        expect.stringContaining('Operator quotes received'),
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

    it('writes the effective deposit percentage onto every quoted offer before sending', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2348000000000' },
      });
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          operatorId: 'op-1',
          quotedPrice: 25000,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: 20,
          },
        },
        {
          id: 'offer-2',
          operatorId: 'op-2',
          quotedPrice: 26000,
          operator: {
            id: 'op-2',
            businessName: 'Raheem Towing',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: null,
          },
        },
      ]);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { depositPercentSnapshot: 20 },
      });
      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-2' },
        data: { depositPercentSnapshot: 10 },
      });
    });

    it('includes the actual deposit amount (not the raw percentage) in each shortlist line', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2348000000000' },
      });
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          operatorId: 'op-1',
          quotedPrice: 25000,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: 20,
          },
        },
      ]);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      // quotedPrice 25,000 + 10% service fee (2,500) = 27,500 total.
      // 20% of that = 5,500 — above the 5,000 kobo floor, so the ordinary
      // percentage-based amount wins (not a special case of this fix).
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348000000000',
        expect.stringContaining('Deposit ₦55'),
      );
    });

    it('shows the real floored amount for a stale 0% override, never a misleading "Deposit 0%" (hotfix, 2026-10-24)', async () => {
      // A customer selecting this quote would be charged the floored amount
      // at checkout (computeDepositAmount) — the shortlist must show that
      // same amount, not a bare "0%" that implies a free job.
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2348000000000' },
      });
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          operatorId: 'op-1',
          quotedPrice: 100_000,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: 0,
          },
        },
      ]);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348000000000',
        expect.stringContaining('Deposit ₦50'),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Deposit 0%'),
      );
    });

    it('writes a fresh snapshot every call, not just the first — overwriting any prior value', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2348000000000' },
      });
      prisma.dispatchOffer.findMany.mockResolvedValue([
        {
          id: 'offer-1',
          operatorId: 'op-1',
          quotedPrice: 25000,
          operator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            latitude: 6.5,
            longitude: 3.4,
            depositPercentOverride: 30, // changed since an earlier round's delivery
          },
        },
      ]);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      await service.deliverQuoteShortlist('req-1', 'cust-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { depositPercentSnapshot: 30 },
      });
    });
  });

  describe('handleDeliveryStatusUpdate', () => {
    let service: DispatchService;
    let prisma: {
      dispatchOffer: { findUnique: jest.Mock; updateMany: jest.Mock };
    };
    let sentryCapture: jest.Mock;

    beforeEach(async () => {
      prisma = {
        dispatchOffer: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'offer-1',
            rescueRequestId: 'req-1',
            operatorId: 'op-1',
          }),
          // count: 1 is the default "the write took" case most tests want.
          // A dedicated test below overrides this to count: 0 to exercise
          // the "guard rejected it" / stale-callback path.
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      sentryCapture = Sentry.captureMessage as jest.Mock;
      sentryCapture.mockClear();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it("persists the SID, status, and error code via one atomic conditional update, tagged by the offer's own id", async () => {
      await service.handleDeliveryStatusUpdate(
        'offer-1',
        'SM123',
        'undelivered',
        63024,
      );

      expect(prisma.dispatchOffer.findUnique).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        select: { id: true, rescueRequestId: true, operatorId: true },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a nested expect.objectContaining(...) value loses its generic inference when assigned to an outer objectContaining's property; same @types/jest looseness as the expect.not case elsewhere in this codebase
          where: expect.objectContaining({ id: 'offer-1' }),
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'undelivered',
            deliveryErrorCode: 63024,
          },
        }),
      );
    });

    it('persists a status with no error code (e.g. delivered) as deliveryErrorCode: null', async () => {
      await service.handleDeliveryStatusUpdate(
        'offer-1',
        'SM123',
        'delivered',
        undefined,
      );

      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'delivered',
            deliveryErrorCode: null,
          },
        }),
      );
    });

    it('no-ops when no offer matches the offerId, rather than throwing', async () => {
      prisma.dispatchOffer.findUnique.mockResolvedValue(null);

      await expect(
        service.handleDeliveryStatusUpdate(
          'offer-unknown',
          'SM-unknown',
          'undelivered',
          63024,
        ),
      ).resolves.toBeUndefined();

      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
    });

    describe('alerting — gated on whether the atomic update actually wrote anything', () => {
      it('fires a Sentry alert for an undelivered status when the update reports count: 1 (the write took)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'undelivered',
          63024,
        );

        expect(sentryCapture).toHaveBeenCalledWith(
          expect.stringContaining('undelivered'),
          expect.objectContaining({
            level: 'error',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a nested expect.objectContaining(...) value loses its generic inference when assigned to an outer objectContaining's property; same @types/jest looseness as the expect.not case elsewhere in this codebase
            extra: expect.objectContaining({
              rescueRequestId: 'req-1',
              operatorId: 'op-1',
              messageSid: 'SM123',
              errorCode: 63024,
            }),
          }),
        );
      });

      it('fires a Sentry alert for a failed status', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'failed',
          30008,
        );

        expect(sentryCapture).toHaveBeenCalled();
      });

      it('does not alert on a non-failure status (sent/delivered/read)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'delivered',
          undefined,
        );
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'read',
          undefined,
        );
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        expect(sentryCapture).not.toHaveBeenCalled();
      });

      it('does not alert when the atomic update reports count: 0 — the guard rejected a stale/out-of-order callback, nothing was actually written', async () => {
        // This is the case the old read-then-write design couldn't express
        // atomically: the real DB's WHERE clause is what decides whether
        // this write "counts," not a value this process read earlier.
        prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });

        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'undelivered',
          63024,
        );

        expect(sentryCapture).not.toHaveBeenCalled();
      });
    });

    describe('out-of-order guard construction', () => {
      // These test the WHERE clause DispatchService builds, not Prisma's
      // own filtering (that's covered by the real-Postgres integration
      // test at test/integration/dispatch-delivery-status.int-spec.ts —
      // multi-llm review caught that this comment previously pointed at
      // Task 3's dispatch-round-state update, which only ever checked
      // twilioMessageSid persistence and never exercised this guard at
      // all). Assertions are content-based
      // (arrayContaining), not exact-order, since the guard's job is "which
      // statuses are/aren't in the allowed set," not array ordering.
      type DeliveryStatusGuardCall = {
        where: {
          id: string;
          OR: Array<{
            deliveryStatus?: null | { in?: string[]; notIn?: string[] };
          }>;
        };
      };

      it('allows overwriting only a not-more-advanced existing status for a recognized incoming status', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        const calls = prisma.dispatchOffer.updateMany.mock.calls as [
          DeliveryStatusGuardCall,
        ][];
        const call = calls[0][0];
        expect(call.where.id).toBe('offer-1');
        const allowedExisting = call.where.OR.find(
          (clause: { deliveryStatus?: { in?: string[] } }) =>
            clause.deliveryStatus?.in,
        )?.deliveryStatus?.in;
        // 'sent' only ranks above queued/accepted/sending.
        expect(allowedExisting).toEqual(
          expect.arrayContaining(['queued', 'accepted', 'sending', 'sent']),
        );
        expect(allowedExisting).not.toEqual(
          expect.arrayContaining([
            'delivered',
            'read',
            'undelivered',
            'failed',
          ]),
        );
      });

      it('always allows a null existing deliveryStatus to be overwritten (the first-ever callback for an offer)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        const calls = prisma.dispatchOffer.updateMany.mock.calls as [
          DeliveryStatusGuardCall,
        ][];
        const call = calls[0][0];
        expect(call.where.OR).toEqual(
          expect.arrayContaining([{ deliveryStatus: null }]),
        );
      });

      it('always allows overwriting an existing status this process does not recognize, for a recognized incoming status', async () => {
        // An unrecognized already-recorded status can't be ranked against
        // anything — rather than permanently block every future write to
        // this offer, the guard explicitly carves this out.
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'delivered',
          undefined,
        );

        const calls = prisma.dispatchOffer.updateMany.mock.calls as [
          DeliveryStatusGuardCall,
        ][];
        const call = calls[0][0];
        const notInClause = call.where.OR.find(
          (clause: { deliveryStatus?: { notIn?: string[] } }) =>
            clause.deliveryStatus?.notIn,
        );
        expect(notInClause?.deliveryStatus?.notIn).toEqual(
          expect.arrayContaining([
            'queued',
            'sent',
            'delivered',
            'read',
            'undelivered',
            'failed',
          ]),
        );
      });

      it('does NOT allow one terminal status to overwrite a different terminal status already recorded — read/undelivered/failed share a rank but are not interchangeable', async () => {
        // Multi-llm review caught that sharing a rank (all three are
        // equally "final") had been implemented as "equally overwritable,"
        // not "equally un-overwritable" — a late/duplicate 'failed'
        // callback could silently erase a confirmed 'read', which
        // contradicts this file's own design comment: "nothing legitimately
        // follows" a terminal state.
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'failed',
          30008,
        );

        const calls = prisma.dispatchOffer.updateMany.mock.calls as [
          DeliveryStatusGuardCall,
        ][];
        const call = calls[0][0];
        const allowedExisting = call.where.OR.find(
          (clause: { deliveryStatus?: { in?: string[] } }) =>
            clause.deliveryStatus?.in,
        )?.deliveryStatus?.in;
        expect(allowedExisting).not.toEqual(
          expect.arrayContaining(['read', 'undelivered', 'failed']),
        );
        // Still ranks above every non-terminal status.
        expect(allowedExisting).toEqual(
          expect.arrayContaining([
            'queued',
            'accepted',
            'sending',
            'sent',
            'delivered',
          ]),
        );
      });

      it('does not re-alert (or re-write) when Twilio redelivers the same terminal callback — at-least-once delivery is not a new event', async () => {
        prisma.dispatchOffer.findUnique.mockResolvedValue({
          id: 'offer-1',
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
        });
        // Simulate the already-terminal row the atomic guard would reject
        // against: updateMany's WHERE now excludes 'failed' from the
        // overwritable set (per the fix above), so a real Postgres would
        // return count: 0 for this redelivery — assert the same outcome
        // the mock is told to report.
        prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });

        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123-retry',
          'failed',
          30008,
        );

        expect(sentryCapture).not.toHaveBeenCalled();
      });

      it('applies no ranking constraint at all when the incoming status itself is unrecognized — never silently dropped', async () => {
        // Contrast with the old (pre-fix) design, which defaulted an
        // unrecognized status to rank 0 — the lowest possible — meaning it
        // would almost always lose to anything already recorded. Multi-llm
        // review caught that this contradicted the plan's own promise that
        // deliveryStatus is a raw string specifically so a future Twilio
        // status needs no code change to keep recording correctly.
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'some-future-status',
          undefined,
        );

        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'some-future-status',
            deliveryErrorCode: null,
          },
        });
      });
    });
  });

  describe('listMyPendingOffers — media filtering', () => {
    let service: DispatchService;
    let prisma: {
      dispatchOffer: { findMany: jest.Mock };
    };
    let operatorMembershipService: {
      findActiveOperatorIdsForUser: jest.Mock;
    };

    beforeEach(async () => {
      prisma = {
        dispatchOffer: { findMany: jest.fn() },
      };
      operatorMembershipService = {
        findActiveOperatorIdsForUser: jest.fn(),
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
          {
            provide: OperatorMembershipService,
            useValue: operatorMembershipService,
          },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('only queries INITIAL-context media for the pending-offers list', async () => {
      operatorMembershipService.findActiveOperatorIdsForUser.mockResolvedValue([
        'op-1',
      ]);
      prisma.dispatchOffer.findMany.mockResolvedValue([]);

      await service.listMyPendingOffers('op-user-1');

      expect(
        operatorMembershipService.findActiveOperatorIdsForUser,
      ).toHaveBeenCalledWith('op-user-1');

      expect(prisma.dispatchOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            rescueRequest: expect.objectContaining({
              select: expect.objectContaining({
                media: {
                  where: { context: 'INITIAL' },
                  select: { id: true },
                },
              }),
            }),
          }),
        }),
      );
    });
  });

  describe('resolveExhaustion', () => {
    let service: DispatchService;
    let operatorService: { findAndRankCandidates: jest.Mock };

    const baseRescueRequest = {
      id: 'req-1',
      latitude: 6.5,
      longitude: 3.4,
      vehicleType: null,
      offeredOperatorIds: ['op-already-offered'],
      customerId: 'cust-1',
    };

    beforeEach(async () => {
      operatorService = { findAndRankCandidates: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: operatorService },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('flags manual-fallback and does not cancel when a non-WhatsApp candidate exists', async () => {
      operatorService.findAndRankCandidates.mockResolvedValue([
        { id: 'op-backup' },
      ]);
      const tx = {
        rescueRequest: { update: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
        whatsAppSession: { updateMany: jest.fn() },
      } as unknown as Prisma.TransactionClient;

      const result = await service.resolveExhaustion(
        tx,
        baseRescueRequest,
        { reason: 'rounds-exhausted', round: 5, extraRadiusKm: 8 },
        false,
      );

      expect(operatorService.findAndRankCandidates).toHaveBeenCalledWith(
        6.5,
        3.4,
        ['op-already-offered'],
        8,
        undefined,
        undefined,
        false,
        false,
      );
      expect(result).toEqual({
        outcome: 'manual-fallback',
        candidateId: 'op-backup',
      });
      // tx is typed as Prisma.TransactionClient so the mocked methods below
      // are genuine (unbound) method references, not `any` — same looseness
      // as every other bare mock-method assertion in this file, now visible
      // because this one case has a real interface behind it.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tx.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { needsManualAssignment: true, dispatchRound: 5 },
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tx.dispatchOffer.updateMany).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tx.whatsAppSession.updateMany).not.toHaveBeenCalled();
    });

    it('cancels exactly as before when no candidate exists at all, for either reason', async () => {
      operatorService.findAndRankCandidates.mockResolvedValue([]);
      const tx = {
        rescueRequest: { update: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
        whatsAppSession: { updateMany: jest.fn() },
      } as unknown as Prisma.TransactionClient;

      const result = await service.resolveExhaustion(
        tx,
        baseRescueRequest,
        { reason: 'no-coverage', round: 2, extraRadiusKm: 2 },
        false,
      );

      expect(result).toEqual({
        outcome: 'cancelled',
        reason: 'no-coverage',
        round: 2,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- see note above
      expect(tx.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: {
          status: 'CANCELLED',
          needsManualAssignment: false,
          dispatchRound: 2,
        },
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- see note above
      expect(tx.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- see note above
      expect(tx.whatsAppSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'cust-1' },
        data: { state: 'IDLE', rescueRequestId: null },
      });
    });

    it('passes isTestRequest through to findAndRankCandidates unchanged — the test/real operator partition must hold for the fallback search too', async () => {
      operatorService.findAndRankCandidates.mockResolvedValue([
        { id: 'op-backup' },
      ]);
      const tx = {
        rescueRequest: { update: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
        whatsAppSession: { updateMany: jest.fn() },
      } as unknown as Prisma.TransactionClient;

      await service.resolveExhaustion(
        tx,
        baseRescueRequest,
        { reason: 'rounds-exhausted', round: 5, extraRadiusKm: 8 },
        true,
      );

      expect(operatorService.findAndRankCandidates).toHaveBeenCalledWith(
        6.5,
        3.4,
        ['op-already-offered'],
        8,
        undefined,
        undefined,
        true,
        false,
      );
    });
  });

  describe('alertStaffManualFallback', () => {
    let service: DispatchService;
    let platformConfigService: { getConfig: jest.Mock };
    let twilioService: {
      sendWhatsAppMessage: jest.Mock;
      sendWhatsAppTemplateMessage: jest.Mock;
    };
    const originalTemplateSid =
      process.env.TWILIO_MANUAL_FALLBACK_ALERT_TEMPLATE_SID;

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_MANUAL_FALLBACK_ALERT_TEMPLATE_SID;
      else
        process.env.TWILIO_MANUAL_FALLBACK_ALERT_TEMPLATE_SID =
          originalTemplateSid;
    });

    beforeEach(async () => {
      delete process.env.TWILIO_MANUAL_FALLBACK_ALERT_TEMPLATE_SID;
      platformConfigService = {
        getConfig: jest.fn().mockResolvedValue({
          disputeAlertPhoneNumbers: ['+2348011111111', '+2348022222222'],
        }),
      };
      twilioService = {
        sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM_test' }),
        sendWhatsAppTemplateMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_test' }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
      (Sentry.captureException as jest.Mock).mockClear();
    });

    it('fans out to every configured staff number, with per-number failure isolation', async () => {
      twilioService.sendWhatsAppMessage.mockRejectedValueOnce(
        new Error('Twilio down'),
      );

      await service.alertStaffManualFallback('req-1', 3);

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2);
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348011111111'),
        expect.stringContaining('needs a manual call'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348022222222'),
        expect.anything(),
      );
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it('sends nothing and throws nothing when no staff numbers are configured', async () => {
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumbers: [],
      });

      await expect(
        service.alertStaffManualFallback('req-1', 3),
      ).resolves.toBeUndefined();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('sends via the Content Template when configured, instead of freeform', async () => {
      process.env.TWILIO_MANUAL_FALLBACK_ALERT_TEMPLATE_SID = 'HXmanualalert';

      await service.alertStaffManualFallback('req-1', 3);

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348011111111'),
        'HXmanualalert',
        expect.any(Object),
      );
      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348022222222'),
        'HXmanualalert',
        expect.any(Object),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });

  describe('notifyNoOperatorAvailable', () => {
    let service: DispatchService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      user: { findUnique: jest.Mock };
    };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ latitude: 6.5, longitude: 3.4 }),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ phoneNumber: '+2348012345678' }),
        },
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();
      service = module.get<DispatchService>(DispatchService);
    });

    it('notifies the customer via their real phone number', async () => {
      await service.notifyNoOperatorAvailable(
        'req-1',
        'cust-1',
        'no-coverage',
        2,
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348012345678',
        expect.stringContaining('no tow operators available'),
      );
    });

    it('notifies a BSUID-only customer via their BSUID instead of silently skipping them (Task 14, hotfix 2026-10-25)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        phoneNumber: null,
        whatsappExternalUserId: 'CA.masked',
      });

      await service.notifyNoOperatorAvailable(
        'req-1',
        'cust-1',
        'rounds-exhausted',
        5,
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:CA.masked',
        expect.stringContaining('no tow operator was available'),
      );
    });
  });
});
