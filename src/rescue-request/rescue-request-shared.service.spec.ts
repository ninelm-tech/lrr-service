import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { Prisma } from '@prisma/client';

describe('RescueRequestSharedService', () => {
  let service: RescueRequestSharedService;
  let prisma: {
    user: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let geocodingService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        upsert: jest.fn().mockResolvedValue({ id: 'user-1' }),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
      },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestSharedService,
        { provide: PrismaService, useValue: prisma },
        { provide: GeocodingService, useValue: geocodingService },
        {
          provide: TwilioService,
          useValue: { sendWhatsAppMessage: jest.fn() },
        },
        { provide: WhatsAppSessionStore, useValue: { update: jest.fn() } },
      ],
    }).compile();

    service = module.get<RescueRequestSharedService>(
      RescueRequestSharedService,
    );
  });

  describe('findOrCreateCustomer', () => {
    it('upserts a User by phone number with the CUSTOMER role', async () => {
      await service.findOrCreateCustomer('+2348012345678');

      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { phoneNumber: '+2348012345678' },
        update: {},
        create: { phoneNumber: '+2348012345678', role: 'CUSTOMER' },
      });
    });

    it('runs against the given transaction client when one is provided', async () => {
      const txUser = { upsert: jest.fn().mockResolvedValue({ id: 'cust-1' }) };
      const tx = { user: txUser } as never;

      const result = await service.findOrCreateCustomer('+2348012345678', tx);

      expect(txUser.upsert).toHaveBeenCalledWith({
        where: { phoneNumber: '+2348012345678' },
        update: {},
        create: { phoneNumber: '+2348012345678', role: 'CUSTOMER' },
      });
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'cust-1' });
    });
  });

  describe('findOrCreateBySender', () => {
    it('passively captures the BSUID onto an existing phone-matched user', async () => {
      const existing = {
        id: 'user-1',
        phoneNumber: '+2348012345678',
        whatsappExternalUserId: null,
      };
      prisma.user.findUnique.mockResolvedValue(existing);
      prisma.user.update.mockResolvedValue({
        ...existing,
        whatsappExternalUserId: 'CA.999',
      });

      const result = await service.findOrCreateBySender({
        phoneNumber: '+2348012345678',
        externalUserId: 'CA.999',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { phoneNumber: '+2348012345678' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { whatsappExternalUserId: 'CA.999' },
      });
      expect(result.id).toBe('user-1');
      expect(result.whatsappExternalUserId).toBe('CA.999');
    });

    it('clears the BSUID off its old row before moving it onto the phone-matched user, when the same WhatsApp account was previously seen masked under a different row (multi-llm review finding, hotfix 2026-10-25)', async () => {
      // Same real person, same WhatsApp account: a BSUID-only row ('user-2')
      // was created while they were masked, before this message — now they
      // show a real phone, matching a DIFFERENT, pre-existing row
      // ('user-1'). Moving the BSUID onto user-1 would otherwise hit the
      // unique constraint, since user-2 still holds it.
      const phoneMatched = {
        id: 'user-1',
        phoneNumber: '+2348012345678',
        whatsappExternalUserId: null,
      };
      prisma.user.findUnique.mockResolvedValue(phoneMatched);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({
        ...phoneMatched,
        whatsappExternalUserId: 'CA.reunited',
      });

      const result = await service.findOrCreateBySender({
        phoneNumber: '+2348012345678',
        externalUserId: 'CA.reunited',
      });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          whatsappExternalUserId: 'CA.reunited',
          id: { not: 'user-1' },
        },
        data: { whatsappExternalUserId: null },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { whatsappExternalUserId: 'CA.reunited' },
      });
      expect(result.id).toBe('user-1');
      expect(result.whatsappExternalUserId).toBe('CA.reunited');
    });

    it('creates a phoneNumber: null user keyed on externalUserId when no phone is given', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'user-2',
        phoneNumber: null,
        whatsappExternalUserId: 'CA.2512472632651794',
      });

      const result = await service.findOrCreateBySender({
        phoneNumber: null,
        externalUserId: 'CA.2512472632651794',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { whatsappExternalUserId: 'CA.2512472632651794' },
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          phoneNumber: null,
          whatsappExternalUserId: 'CA.2512472632651794',
          role: 'CUSTOMER',
        },
      });
      expect(result.phoneNumber).toBeNull();
      expect(result.whatsappExternalUserId).toBe('CA.2512472632651794');
    });

    it('recovers by re-fetching when a concurrent delivery of the same new-sender message already created the row (multi-llm review finding, hotfix 2026-10-25)', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // no phone match
        .mockResolvedValueOnce(null) // no externalUserId match either
        .mockResolvedValueOnce({
          // the row the concurrent request just committed
          id: 'user-4',
          phoneNumber: '+2348012345678',
          whatsappExternalUserId: 'CA.race',
        });
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['phoneNumber'] },
        }),
      );

      const result = await service.findOrCreateBySender({
        phoneNumber: '+2348012345678',
        externalUserId: 'CA.race',
      });

      expect(result.id).toBe('user-4');
    });

    it('recovers by re-fetching (by BSUID) when a concurrent delivery of the same BSUID-only new-sender message already created the row (multi-llm review finding, hotfix 2026-10-25)', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // no externalUserId match yet
        .mockResolvedValueOnce({
          id: 'user-5',
          phoneNumber: null,
          whatsappExternalUserId: 'CA.race2',
        });
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['whatsappExternalUserId'] },
        }),
      );

      const result = await service.findOrCreateBySender({
        phoneNumber: null,
        externalUserId: 'CA.race2',
      });

      expect(result.id).toBe('user-5');
    });

    it('backfills phoneNumber onto an existing BSUID-linked user instead of duplicating, when the real number reappears', async () => {
      const bsuidOnly = {
        id: 'user-3',
        phoneNumber: null,
        whatsappExternalUserId: 'CA.recovered',
      };
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // no phone match
        .mockResolvedValueOnce(bsuidOnly); // externalUserId match
      prisma.user.update.mockResolvedValue({
        ...bsuidOnly,
        phoneNumber: '+2348099999999',
      });

      const result = await service.findOrCreateBySender({
        phoneNumber: '+2348099999999',
        externalUserId: 'CA.recovered',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-3' },
        data: { phoneNumber: '+2348099999999' },
      });
      expect(result.id).toBe('user-3');
      expect(result.phoneNumber).toBe('+2348099999999');
    });

    it('finds the same user by externalUserId on a returning BSUID-only visit', async () => {
      const existing = {
        id: 'user-4',
        phoneNumber: null,
        whatsappExternalUserId: 'CA.2512472632651794',
      };
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreateBySender({
        phoneNumber: null,
        externalUserId: 'CA.2512472632651794',
      });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(result.id).toBe('user-4');
    });
  });

  describe('formatLocationSection', () => {
    it('returns the address plus a map link when reverse geocoding succeeds', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(
        '12 Adeniyi Jones Ave, Ikeja, Lagos',
      );

      const result = await service.formatLocationSection(6.5, 3.4);

      expect(result).toBe(
        '12 Adeniyi Jones Ave, Ikeja, Lagos\n📍 https://maps.google.com/?q=6.5,3.4',
      );
    });

    it('falls back to the map link alone when reverse geocoding returns nothing', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      const result = await service.formatLocationSection(6.5, 3.4);

      expect(result).toBe('https://maps.google.com/?q=6.5,3.4');
    });
  });

  describe('endRelayForEndedRequest', () => {
    let service: RescueRequestSharedService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      user: { upsert: jest.Mock };
    };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let sessionStore: { clearRelayTargets: jest.Mock };

    const requestWithOperator = {
      id: 'req-1',
      customerId: 'cust-user-1',
      customer: { phoneNumber: '+2341' },
      assignedOperator: { phoneNumber: '+2342', whatsappEnabled: true },
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue(requestWithOperator),
        },
        user: { upsert: jest.fn().mockResolvedValue({ id: 'op-user-1' }) },
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      sessionStore = { clearRelayTargets: jest.fn().mockResolvedValue(2) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestSharedService,
          { provide: PrismaService, useValue: prisma },
          { provide: GeocodingService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
        ],
      }).compile();

      service = module.get(RescueRequestSharedService);
    });

    it('clears the relay for BOTH participants — the operator sits on a separate session row', async () => {
      await service.endRelayForEndedRequest('req-1');

      expect(sessionStore.clearRelayTargets).toHaveBeenCalledWith([
        'cust-user-1',
        'op-user-1',
      ]);
    });

    it('tells both parties the chat is over', async () => {
      await service.endRelayForEndedRequest('req-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2341',
        expect.stringContaining('Chat ended'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2342',
        expect.stringContaining('Chat ended'),
      );
    });

    it('notifies a BSUID-only customer via their BSUID instead of silently skipping them (Task 14, hotfix 2026-10-25)', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...requestWithOperator,
        customer: { phoneNumber: null, whatsappExternalUserId: 'CA.masked' },
      });

      await service.endRelayForEndedRequest('req-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:CA.masked',
        expect.stringContaining('Chat ended'),
      );
    });

    it('stays silent when no relay was open — the common case, and must not spam every completed job', async () => {
      sessionStore.clearRelayTargets.mockResolvedValue(0);

      await service.endRelayForEndedRequest('req-1');

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('never throws — it runs inside payment and cancellation flows that must not fail on it', async () => {
      prisma.rescueRequest.findUnique.mockRejectedValue(new Error('db down'));

      await expect(
        service.endRelayForEndedRequest('req-1'),
      ).resolves.toBeUndefined();
    });

    it('still clears the relay but does not message a non-WhatsApp operator — only the customer', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...requestWithOperator,
        assignedOperator: { phoneNumber: '+2342', whatsappEnabled: false },
      });

      await service.endRelayForEndedRequest('req-1');

      expect(sessionStore.clearRelayTargets).toHaveBeenCalledWith([
        'cust-user-1',
        'op-user-1',
      ]);
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2341',
        expect.stringContaining('Chat ended'),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        '+2342',
        expect.anything(),
      );
    });
  });
});
