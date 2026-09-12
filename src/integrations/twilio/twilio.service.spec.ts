import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TwilioService } from './twilio.service';

describe('TwilioService', () => {
  let service: TwilioService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwilioService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                TWILIO_ACCOUNT_SID: 'ACtest',
                TWILIO_AUTH_TOKEN: 'test-token',
                TWILIO_WHATSAPP_FROM: '+14155238886',
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get<TwilioService>(TwilioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('downloadMedia', () => {
    it('fetches the URL with Basic Auth using the Twilio credentials and returns a Buffer', async () => {
      const fakeBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer,
      });
      global.fetch = fetchMock as any;

      const result = await service.downloadMedia('https://api.twilio.com/media/ME123');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.twilio.com/media/ME123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('ACtest:test-token').toString('base64')}`,
          }),
        }),
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it('throws if the fetch response is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;

      await expect(service.downloadMedia('https://api.twilio.com/media/missing')).rejects.toThrow();
    });
  });
});
