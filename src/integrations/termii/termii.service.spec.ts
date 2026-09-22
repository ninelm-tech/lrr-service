import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { TermiiService } from './termii.service';

describe('TermiiService', () => {
  async function buildService(config: Record<string, string | undefined>) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TermiiService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
      ],
    }).compile();
    return module.get<TermiiService>(TermiiService);
  }

  it('does not throw on construction when TERMII_API_KEY is missing — matches TwilioService leniency', async () => {
    await expect(buildService({})).resolves.toBeDefined();
  });

  describe('sendOtp', () => {
    it("posts to /sms/otp/send on Termii's shared OTP sender, and returns the pinId", async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_BASE_URL: 'https://v3.api.termii.com/api',
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ pinId: 'pin-abc123' })),
      });
      global.fetch = fetchMock as typeof fetch;

      const result = await service.sendOtp(
        '+2348012345678',
        'Your LRR verification code is < 1234 >. This code expires in 10 minutes. Do not share with anyone',
        10,
      );

      expect(result).toEqual({ pinId: 'pin-abc123' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://v3.api.termii.com/api/sms/otp/send',
        expect.objectContaining({ method: 'POST' }),
      );
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body).toEqual({
        api_key: 'test-key',
        message_type: 'NUMERIC',
        to: '+2348012345678',
        from: 'OE Alert',
        channel: 'dnd',
        pin_attempts: 3,
        pin_time_to_live: 10,
        pin_length: 6,
        pin_placeholder: '< 1234 >',
        message_text:
          'Your LRR verification code is < 1234 >. This code expires in 10 minutes. Do not share with anyone',
        pin_type: 'NUMERIC',
      });
    });

    it('throws InternalServerErrorException when the send fails', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        text: () =>
          Promise.resolve(JSON.stringify({ message: 'Insufficient balance' })),
      }) as typeof fetch;

      await expect(
        service.sendOtp('+2348012345678', 'code text', 10),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('throws InternalServerErrorException (not a raw parse crash) when Termii returns a non-JSON error body', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve(''), // e.g. Termii's real empty-body 401
      }) as typeof fetch;

      await expect(
        service.sendOtp('+2348012345678', 'code text', 10),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('verifyOtp', () => {
    it("posts to /sms/otp/verify and normalizes Termii's 'True' string to verified: true", async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_BASE_URL: 'https://v3.api.termii.com/api',
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ verified: 'True' })),
      });
      global.fetch = fetchMock as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '123456');

      expect(result).toEqual({ verified: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://v3.api.termii.com/api/sms/otp/verify',
        expect.objectContaining({ method: 'POST' }),
      );
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(options.body as string)).toEqual({
        api_key: 'test-key',
        pin_id: 'pin-abc123',
        pin: '123456',
      });
    });

    it('treats a boolean true as verified — a valid code Termii accepted (HTTP 200) was being rejected because only the string "True" was recognized', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ verified: true })),
      }) as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '123456');

      expect(result).toEqual({ verified: true });
    });

    it('accepts the string "true" in any casing', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ verified: 'true' })),
      }) as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '123456');

      expect(result).toEqual({ verified: true });
    });

    it('does not treat a boolean false as verified', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ verified: false })),
      }) as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '000000');

      expect(result).toEqual({ verified: false });
    });

    it('logs the shape of an unverified 200 response (never the pin, pinId or phone) so an unexpected body is diagnosable', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              pinId: 'pin-secret',
              verified: 'Expired',
              msisdn: '2348012345678',
            }),
          ),
      }) as typeof fetch;

      await service.verifyOtp('pin-secret', '000000');

      expect(warn).toHaveBeenCalledWith('Termii verifyOtp: not verified', {
        verified: 'Expired',
        verifiedType: 'string',
        keys: ['pinId', 'verified', 'msisdn'],
      });
      warn.mockRestore();
    });

    it('reports an already-consumed pin as alreadyUsed (not an error) — Termii pins are single-use and its real 400 is "Token … has already been verified"', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: true,
              message: 'Token pin-abc123 has already been verified',
            }),
          ),
      }) as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '123456');

      expect(result).toEqual({ verified: false, alreadyUsed: true });
      expect(consoleError).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it('still treats any other non-ok verify response (e.g. "Pin is required") as a server error', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: true,
              validationErrors: { pin: 'Pin is required' },
            }),
          ),
      }) as typeof fetch;

      await expect(service.verifyOtp('pin-abc123', '')).rejects.toThrow(
        InternalServerErrorException,
      );
      jest.restoreAllMocks();
    });

    it("normalizes an 'Expired' or wrong-code result to verified: false, without throwing", async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ verified: 'Expired' })),
      }) as typeof fetch;

      const result = await service.verifyOtp('pin-abc123', '000000');

      expect(result).toEqual({ verified: false });
    });

    it('throws InternalServerErrorException when the HTTP call itself fails', async () => {
      const service = await buildService({ TERMII_API_KEY: 'test-key' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve(''),
      }) as typeof fetch;

      await expect(service.verifyOtp('pin-abc123', '123456')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
