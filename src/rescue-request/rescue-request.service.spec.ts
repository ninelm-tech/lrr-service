import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('RescueRequestService', () => {
  let service: RescueRequestService;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestService,
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: S3Service, useValue: {} },
      ],
    }).compile();

    service = module.get<RescueRequestService>(RescueRequestService);
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('buildMediaLinksSection', () => {
    it('returns an empty string when there are no media items', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([]);
      expect(result).toBe('');
    });

    it('returns an empty string when API_BASE_URL is not configured', () => {
      delete process.env.API_BASE_URL;
      const result = (service as any).buildMediaLinksSection([{ id: 'media-1' }]);
      expect(result).toBe('');
    });

    it('builds one /media/:id link per item under API_BASE_URL/api/v1', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([
        { id: 'media-1' },
        { id: 'media-2' },
      ]);
      expect(result).toBe(
        '\n\n📎 Photos/Video/Audio:\nhttps://api.lrr.ninelm.com/api/v1/media/media-1\nhttps://api.lrr.ninelm.com/api/v1/media/media-2',
      );
    });
  });
});
