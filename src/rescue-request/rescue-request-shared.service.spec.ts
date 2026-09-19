import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';

describe('RescueRequestSharedService', () => {
  let service: RescueRequestSharedService;
  let prisma: { user: { upsert: jest.Mock } };
  let geocodingService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1' }) },
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
      assignedOperator: { phoneNumber: '+2342' },
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
        '+2341',
        expect.stringContaining('Chat ended'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2342',
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
  });
});
