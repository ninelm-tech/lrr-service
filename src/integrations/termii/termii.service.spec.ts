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

  describe('sendSms', () => {
    it('posts to /sms/send with the literal message text', async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_SENDER_ID: 'LRR',
        TERMII_BASE_URL: 'https://v3.api.termii.com/api',
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message_id: 'msg-1' }),
      });
      global.fetch = fetchMock as any;

      await service.sendSms(
        '+2348012345678',
        'Your LRR verification code is 123456.',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://v3.api.termii.com/api/sms/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(
            'Your LRR verification code is 123456.',
          ),
        }),
      );
      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body).toEqual({
        api_key: 'test-key',
        to: '+2348012345678',
        from: 'LRR',
        sms: 'Your LRR verification code is 123456.',
        type: 'plain',
        channel: 'generic',
      });
    });

    it('throws InternalServerErrorException when the HTTP call fails', async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_SENDER_ID: 'LRR',
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ message: 'Insufficient balance' }),
      }) as any;

      await expect(service.sendSms('+2348012345678', 'code')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
