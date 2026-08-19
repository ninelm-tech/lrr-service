import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { S3Service } from '../integrations/s3/s3.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { RatingService } from '../rating/rating.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { OperatorService } from '../operator/operator.service';
import { DispatchService } from './dispatch.service';
import { DisputeService } from './dispute.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('WhatsAppCustomerFlowService', () => {
  describe('handleRatingReply', () => {
    let ratingTestService: WhatsAppCustomerFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn(), getOrCreate: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: { reverseGeocode: jest.fn().mockResolvedValue(null) } },
          { provide: RatingService, useValue: ratingServiceMock },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestService, useValue: {} },
        ],
      }).compile();

      ratingTestService = module.get<WhatsAppCustomerFlowService>(WhatsAppCustomerFlowService);
    });

    it('creates a MOTORIST_TO_OPERATOR rating for a valid customer-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-1' });

      await ratingTestService.handleRatingReply('cust-1', '5', 'req-1', 'MOTORIST_TO_OPERATOR' as any);

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5,
      });
    });

    it('creates an OPERATOR_TO_MOTORIST rating for a valid operator-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-2' });

      await ratingTestService.handleRatingReply('op-user-1', '4', 'req-1', 'OPERATOR_TO_MOTORIST' as any);

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'OPERATOR_TO_MOTORIST', operatorId: 'op-1', customerId: 'cust-1', score: 4,
      });
    });

    it('re-prompts and does not create a rating for invalid input', async () => {
      await ratingTestService.handleRatingReply('cust-1', 'banana', 'req-1', 'MOTORIST_TO_OPERATOR' as any);

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('re-prompts and does not create a rating for an out-of-range number', async () => {
      await ratingTestService.handleRatingReply('cust-1', '7', 'req-1', 'MOTORIST_TO_OPERATOR' as any);

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });
  });

  describe('WAITING_FOR_DESTINATION', () => {
    let destService: WhatsAppCustomerFlowService;
    let prisma: {
      rescueRequest: { create: jest.Mock };
    };
    let sessionStore: { update: jest.Mock };
    let geocodingService: { reverseGeocode: jest.Mock };
    let rescueRequestService: { findOrCreateCustomer: jest.Mock };
    const phoneNumber = '+2348012345678';
    const userId = 'user-1';
    const baseSession = {
      state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      latitude: 6.5, longitude: 3.4, vehicleType: 'SEDAN',
    } as any;

    beforeEach(async () => {
      prisma = {
        rescueRequest: { create: jest.fn().mockResolvedValue({ id: 'req-1' }) },
      };
      sessionStore = { update: jest.fn() };
      geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };
      rescueRequestService = { findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'cust-1' }) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppCustomerFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: { sendWhatsAppMessage: jest.fn() } },
          { provide: S3Service, useValue: {} },
          { provide: GeocodingService, useValue: geocodingService },
          { provide: RatingService, useValue: {} },
          { provide: PaystackService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: DisputeService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: RescueRequestService, useValue: rescueRequestService },
        ],
      }).compile();

      destService = module.get<WhatsAppCustomerFlowService>(WhatsAppCustomerFlowService);
    });

    it('uses WhatsApp\'s own formatted address when a "search for a place" share includes one', async () => {
      await destService.handleCustomerMessage(
        phoneNumber, userId, '', '', 6.6, 3.5, 'Mechanic Village, Ojodu', baseSession, {},
      );

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: 'Mechanic Village, Ojodu' }),
      }));
    });

    it('reverse-geocodes a bare "current location" pin with no Address field', async () => {
      geocodingService.reverseGeocode.mockResolvedValue('14 Adeniyi Jones Ave, Ikeja, Lagos');

      await destService.handleCustomerMessage(
        phoneNumber, userId, '', '', 6.6, 3.5, undefined, baseSession, {},
      );

      expect(geocodingService.reverseGeocode).toHaveBeenCalledWith(6.6, 3.5);
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: '14 Adeniyi Jones Ave, Ikeja, Lagos' }),
      }));
    });

    it('falls back to raw coordinates when a pin is shared but geocoding fails', async () => {
      geocodingService.reverseGeocode.mockResolvedValue(null);

      await destService.handleCustomerMessage(
        phoneNumber, userId, '', '', 6.6, 3.5, undefined, baseSession, {},
      );

      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: '6.6, 3.5' }),
      }));
    });

    it('still accepts typed text destinations unchanged', async () => {
      await destService.handleCustomerMessage(
        phoneNumber, userId, 'mainland towing yard', 'Mainland Towing Yard', undefined, undefined, undefined, baseSession, {},
      );

      expect(geocodingService.reverseGeocode).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ destination: 'Mainland Towing Yard' }),
      }));
    });

    it('prompts again when neither text nor a pin is provided', async () => {
      const result = await destService.handleCustomerMessage(
        phoneNumber, userId, '', '', undefined, undefined, undefined, baseSession, {},
      );

      expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
      expect(result).toContain('type where you');
    });
  });
});
