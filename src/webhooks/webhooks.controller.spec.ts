import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { WebhooksController } from './webhooks.controller';
import { WhatsAppInboundService } from '../rescue-request/whatsapp-inbound.service';
import { PaymentService } from '../payment/payment.service';
import { DispatchService } from '../rescue-request/dispatch.service';
import { TwilioService } from '../integrations/twilio/twilio.service';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let twilioService: { verifyStatusCallbackSignature: jest.Mock };
  let dispatchService: { handleDeliveryStatusUpdate: jest.Mock };
  let sentryCapture: jest.Mock;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    twilioService = {
      verifyStatusCallbackSignature: jest.fn().mockReturnValue(true),
    };
    dispatchService = {
      handleDeliveryStatusUpdate: jest.fn().mockResolvedValue(undefined),
    };
    sentryCapture = Sentry.captureMessage as jest.Mock;
    sentryCapture.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WhatsAppInboundService, useValue: {} },
        { provide: PaymentService, useValue: {} },
        { provide: DispatchService, useValue: dispatchService },
        { provide: TwilioService, useValue: twilioService },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  afterEach(() => {
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('handleTwilioStatusCallback', () => {
    const body = {
      MessageSid: 'SM123',
      MessageStatus: 'undelivered',
      ErrorCode: '63024',
    };

    it('verifies the signature against the exact registered callback URL, including /api/v1 and the offerId query param', async () => {
      // /api/v1 matters: main.ts calls app.setGlobalPrefix('api/v1'), so
      // this route is actually served under that prefix — a verification
      // URL missing it would never match what Twilio actually signed.
      await controller.handleTwilioStatusCallback('offer-1', body, 'sig123');

      expect(twilioService.verifyStatusCallbackSignature).toHaveBeenCalledWith(
        'sig123',
        'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-1',
        body,
      );
    });

    it('forwards offerId/MessageSid/MessageStatus/parsed ErrorCode to DispatchService on a valid signature', async () => {
      await controller.handleTwilioStatusCallback('offer-1', body, 'sig123');

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'undelivered',
        63024,
      );
    });

    it('passes undefined for ErrorCode when the callback has none (e.g. a delivered status)', async () => {
      await controller.handleTwilioStatusCallback(
        'offer-1',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'delivered',
        undefined,
      );
    });

    it('passes undefined for ErrorCode when Twilio sends a non-numeric value, rather than NaN', async () => {
      // Twilio has never been observed sending a non-numeric ErrorCode,
      // but this field is attacker/proxy-reachable input before it hits
      // an `Int` column — Number('not-a-number') is NaN, and persisting
      // NaN to an Int column is a Prisma runtime error, not a validation
      // error caught earlier in the request.
      await controller.handleTwilioStatusCallback(
        'offer-1',
        {
          MessageSid: 'SM123',
          MessageStatus: 'failed',
          ErrorCode: 'not-a-number',
        },
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'failed',
        undefined,
      );
    });

    it('rejects and never calls DispatchService when the signature is invalid', async () => {
      twilioService.verifyStatusCallbackSignature.mockReturnValue(false);

      const result = await controller.handleTwilioStatusCallback(
        'offer-1',
        body,
        'bad-sig',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).not.toHaveBeenCalled();
      expect(sentryCapture).toHaveBeenCalledWith(
        expect.stringContaining('Invalid Twilio status callback signature'),
        'error',
      );
      expect(result).toEqual({ status: 'error', message: 'Invalid signature' });
    });

    it('does not call DispatchService when offerId is missing, even with a valid signature', async () => {
      // Defensive: Twilio always sends back whatever query string it was
      // given, but nothing enforces that at compile time on our side —
      // this proves a malformed/missing offerId still no-ops cleanly
      // rather than calling DispatchService with 'undefined' as an id.
      await controller.handleTwilioStatusCallback(
        undefined as unknown as string,
        body,
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).not.toHaveBeenCalled();
    });

    it('rejects cleanly (does not throw) when API_BASE_URL is unset — a malformed verification URL must not 500', async () => {
      // Multi-llm review caught that building the verification URL via
      // plain string interpolation, with no check that API_BASE_URL is
      // actually set, means an unconfigured env (e.g. a fresh
      // local/sandbox deploy) throws inside Twilio SDK's validateRequest
      // (new URL('undefined/api/v1/...') is not a valid URL) — a request
      // Twilio can genuinely send should get a clean rejection, not an
      // unhandled 500.
      delete process.env.API_BASE_URL;

      const result = await controller.handleTwilioStatusCallback(
        'offer-1',
        body,
        'sig123',
      );

      expect(
        twilioService.verifyStatusCallbackSignature,
      ).not.toHaveBeenCalled();
      expect(dispatchService.handleDeliveryStatusUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'error',
        message: 'Service misconfigured',
      });
    });
  });
});
