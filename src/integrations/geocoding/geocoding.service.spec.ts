import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GeocodingService } from './geocoding.service';

describe('GeocodingService', () => {
  let service: GeocodingService;
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    configService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodingService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<GeocodingService>(GeocodingService);
  });

  it('returns null without calling out when no API key is configured', async () => {
    configService.get.mockReturnValue(undefined);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const result = await service.reverseGeocode(6.5, 3.4);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the formatted address on a successful lookup', async () => {
    configService.get.mockReturnValue('test-key');
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({
        status: 'OK',
        results: [{ formatted_address: '12 Adeniyi Jones Ave, Ikeja, Lagos' }],
      }),
    });
    global.fetch = fetchMock as any;

    const result = await service.reverseGeocode(6.5, 3.4);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://maps.googleapis.com/maps/api/geocode/json?latlng=6.5,3.4&key=test-key',
    );
    expect(result).toBe('12 Adeniyi Jones Ave, Ikeja, Lagos');
  });

  it('returns null when Google reports a non-OK status', async () => {
    configService.get.mockReturnValue('test-key');
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    }) as any;

    const result = await service.reverseGeocode(0, 0);

    expect(result).toBeNull();
  });

  it('returns null instead of throwing when the request fails', async () => {
    configService.get.mockReturnValue('test-key');
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as any;

    const result = await service.reverseGeocode(6.5, 3.4);

    expect(result).toBeNull();
  });
});
