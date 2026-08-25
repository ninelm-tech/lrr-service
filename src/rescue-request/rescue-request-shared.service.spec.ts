import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';

describe('RescueRequestSharedService', () => {
  let service: RescueRequestSharedService;
  let prisma: { user: { upsert: jest.Mock } };
  let geocodingService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    prisma = { user: { upsert: jest.fn().mockResolvedValue({ id: 'user-1' }) } };
    geocodingService = { reverseGeocode: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestSharedService,
        { provide: PrismaService, useValue: prisma },
        { provide: GeocodingService, useValue: geocodingService },
        { provide: TwilioService, useValue: { sendWhatsAppMessage: jest.fn() } },
      ],
    }).compile();

    service = module.get<RescueRequestSharedService>(RescueRequestSharedService);
  });

  describe('findOrCreateCustomer', () => {
    it('upserts a User by phone number with the CUSTOMER role', async () => {
      await service.findOrCreateCustomer('+2348012345678');

      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where:  { phoneNumber: '+2348012345678' },
        update: {},
        create: { phoneNumber: '+2348012345678', role: 'CUSTOMER' },
      });
    });
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

  describe('scheduleDepositWindow', () => {
    let fullPrisma: {
      rescueRequest: { findUnique: jest.Mock; updateMany: jest.Mock };
      dispatchOffer: { updateMany: jest.Mock };
      user: { upsert: jest.Mock };
    };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    beforeEach(async () => {
      fullPrisma = {
        rescueRequest: { findUnique: jest.fn(), updateMany: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
        user: { upsert: jest.fn() },
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestSharedService,
          { provide: PrismaService, useValue: fullPrisma },
          { provide: GeocodingService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
        ],
      }).compile();

      service = module.get(RescueRequestSharedService);
    });

    afterEach(() => jest.useRealTimers());

    it('cancels the request at 30 minutes when the claim succeeds — no startDispatch call, no DISPATCHING reset', async () => {
      jest.useFakeTimers();
      // The reminder pre-checks (t=5, t=15, t=25) run first; keep them harmless.
      fullPrisma.rescueRequest.findUnique.mockResolvedValue({ status: 'WAITING_FOR_DEPOSIT' });
      fullPrisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
      fullPrisma.dispatchOffer.updateMany.mockResolvedValue({ count: 1 });

      service.scheduleDepositWindow({
        rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
        paymentUrl: 'https://paystack.com/pay/abc',
      });

      jest.advanceTimersByTime(30 * 60 * 1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); // flush pending microtasks from the timer callback

      expect(fullPrisma.rescueRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', status: 'WAITING_FOR_DEPOSIT' },
        data: { status: 'CANCELLED' },
      });
      expect(fullPrisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ rescueRequestId: 'req-1' }) }),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining("didn't receive payment confirmation"),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2342',
        expect.stringContaining('no longer available'),
      );
    });

    it('does nothing if the payment webhook already claimed the row (race at t=30)', async () => {
      jest.useFakeTimers();
      fullPrisma.rescueRequest.findUnique.mockResolvedValue({ status: 'WAITING_FOR_DEPOSIT' });
      fullPrisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 }); // payment webhook won

      service.scheduleDepositWindow({
        rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
        paymentUrl: 'https://paystack.com/pay/abc',
      });

      jest.advanceTimersByTime(30 * 60 * 1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // Reminders at t=5/15/25 legitimately fire (status is still WAITING_FOR_DEPOSIT
      // at each pre-check) — this test is only about the t=30 claim losing the race,
      // so it must not have sent either of the cancellation-specific messages.
      expect(fullPrisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining("didn't receive payment confirmation"),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        '+2342',
        expect.stringContaining('no longer available'),
      );
    });

    it('skips a reminder if the request is no longer WAITING_FOR_DEPOSIT by the time it fires', async () => {
      jest.useFakeTimers();
      fullPrisma.rescueRequest.findUnique.mockResolvedValue({ status: 'OPERATOR_ASSIGNED' }); // paid already
      fullPrisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });

      service.scheduleDepositWindow({
        rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
        paymentUrl: 'https://paystack.com/pay/abc',
      });

      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve(); await Promise.resolve();

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });
});
