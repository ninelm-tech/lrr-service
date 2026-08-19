import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

describe('RescueRequestService', () => {
  let service: RescueRequestService;
  let geocodingService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestService,
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: GeocodingService, useValue: geocodingService },
        { provide: WhatsAppOperatorFlowService, useValue: {} },
        { provide: WhatsAppCustomerFlowService, useValue: {} },
      ],
    }).compile();

    service = module.get<RescueRequestService>(RescueRequestService);
  });

  describe('formatLocationSection', () => {
    it('returns the address plus a map link when reverse geocoding succeeds', async () => {
      geocodingService.reverseGeocode.mockResolvedValue('12 Adeniyi Jones Ave, Ikeja, Lagos');

      const result = await service.formatLocationSection(6.5, 3.4);

      expect(result).toBe('12 Adeniyi Jones Ave, Ikeja, Lagos\n📍 https://maps.google.com/?q=6.5,3.4');
    });

    it('falls back to the map link alone when reverse geocoding returns nothing', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      const result = await service.formatLocationSection(6.5, 3.4);

      expect(result).toBe('https://maps.google.com/?q=6.5,3.4');
    });
  });

  describe('handleIncomingWhatsAppMessage — routing', () => {
    let prisma: {
      user: { upsert: jest.Mock };
      operator: { findUnique: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock };
    let operatorFlowService: { handleOperatorMessage: jest.Mock };
    let customerFlowService: { handleCustomerMessage: jest.Mock };
    let routingService: RescueRequestService;
    const phoneNumber = '+2348012345678';

    beforeEach(async () => {
      prisma = {
        user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        operator: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      sessionStore = { getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }) };
      operatorFlowService = { handleOperatorMessage: jest.fn().mockResolvedValue('operator-reply') };
      customerFlowService = { handleCustomerMessage: jest.fn().mockResolvedValue('customer-reply') };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn() } },
          { provide: WhatsAppOperatorFlowService, useValue: operatorFlowService },
          { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
        ],
      }).compile();

      routingService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('routes to WhatsAppOperatorFlowService when the sender is a known operator', async () => {
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', businessName: 'Swift Towing', phoneNumber });

      const result = await routingService.handleIncomingWhatsAppMessage({ From: `whatsapp:${phoneNumber}`, Body: 'hi' });

      expect(operatorFlowService.handleOperatorMessage).toHaveBeenCalledWith(
        phoneNumber, 'user-1', 'hi', { state: 'IDLE' }, { id: 'op-1', businessName: 'Swift Towing', phoneNumber },
      );
      expect(customerFlowService.handleCustomerMessage).not.toHaveBeenCalled();
      expect(result).toBe('operator-reply');
    });

    it('routes to WhatsAppCustomerFlowService when the sender is not a known operator', async () => {
      const body = { From: `whatsapp:${phoneNumber}`, Body: 'HELP' };

      const result = await routingService.handleIncomingWhatsAppMessage(body);

      expect(customerFlowService.handleCustomerMessage).toHaveBeenCalledWith(
        phoneNumber, 'user-1', 'help', 'HELP', undefined, undefined, undefined, { state: 'IDLE' }, body,
      );
      expect(operatorFlowService.handleOperatorMessage).not.toHaveBeenCalled();
      expect(result).toBe('customer-reply');
    });
  });
});
