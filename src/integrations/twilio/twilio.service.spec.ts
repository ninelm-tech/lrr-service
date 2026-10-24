import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TwilioMediaDownloadError, TwilioService } from './twilio.service';

const mockMessagesCreate = jest.fn<Promise<{ sid: string }>, unknown[]>();
const mockValidateRequest = jest.fn<boolean, unknown[]>();

jest.mock('twilio', () => ({
  Twilio: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
  validateRequest: (...args: unknown[]) => mockValidateRequest(...args),
}));

describe('TwilioService', () => {
  let service: TwilioService;

  beforeEach(async () => {
    mockMessagesCreate.mockReset();
    mockValidateRequest.mockReset();
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

  describe('sendWhatsAppMessage', () => {
    it('returns the Twilio-assigned SID', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      const result = await service.sendWhatsAppMessage(
        '+2348012345678',
        'hello',
      );

      expect(result).toEqual({ sid: 'SM123' });
    });

    it('passes statusCallback through to Twilio when given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      await service.sendWhatsAppMessage('+2348012345678', 'hello', {
        statusCallback: 'https://api.example.com/webhooks/twilio-status',
      });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCallback: 'https://api.example.com/webhooks/twilio-status',
        }),
      );
    });

    it('omits statusCallback from the Twilio call when not given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      await service.sendWhatsAppMessage('+2348012345678', 'hello');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.not is loosely typed in this @types/jest version; expect.objectContaining (no .not) on the same shape elsewhere in this file doesn't trigger it
        expect.not.objectContaining({ statusCallback: expect.anything() }),
      );
    });
  });

  describe('sendWhatsAppTemplateMessage', () => {
    it('returns the Twilio-assigned SID', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM456' });

      const result = await service.sendWhatsAppTemplateMessage(
        '+2348012345678',
        'HXtest',
        { '1': 'a' },
      );

      expect(result).toEqual({ sid: 'SM456' });
    });

    it('passes statusCallback through to Twilio when given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM456' });

      await service.sendWhatsAppTemplateMessage(
        '+2348012345678',
        'HXtest',
        { '1': 'a' },
        { statusCallback: 'https://api.example.com/webhooks/twilio-status' },
      );

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCallback: 'https://api.example.com/webhooks/twilio-status',
        }),
      );
    });
  });

  describe('verifyStatusCallbackSignature', () => {
    it("delegates to Twilio's validateRequest with the configured auth token", () => {
      mockValidateRequest.mockReturnValue(true);

      const result = service.verifyStatusCallbackSignature(
        'sig123',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
      );

      expect(result).toBe(true);
      expect(mockValidateRequest).toHaveBeenCalledWith(
        'test-token',
        'sig123',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
      );
    });

    it('returns false when validateRequest rejects the signature', () => {
      mockValidateRequest.mockReturnValue(false);

      const result = service.verifyStatusCallbackSignature(
        'bad-sig',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123' },
      );

      expect(result).toBe(false);
    });
  });

  describe('downloadMedia', () => {
    it('fetches the URL with Basic Auth using the Twilio credentials and returns a Buffer', async () => {
      const fakeBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer,
      });
      global.fetch = fetchMock as any;

      const result = await service.downloadMedia(
        'https://api.twilio.com/media/ME123',
      );

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
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await expect(
        service.downloadMedia('https://api.twilio.com/media/missing'),
      ).rejects.toMatchObject({
        name: 'TwilioMediaDownloadError',
        status: 404,
      } satisfies Partial<TwilioMediaDownloadError>);
    });
  });
});
