import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';

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
});
