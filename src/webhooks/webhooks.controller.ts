import {
  Body,
  Controller,
  Post,
  Header,
  Headers,
  HttpCode,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';
import { WhatsAppInboundService } from '../rescue-request/whatsapp-inbound.service';
import { PaymentService } from '../payment/payment.service';
import { DispatchService } from '../rescue-request/dispatch.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import type { TwilioStatusCallbackBody } from './dto/twilio-status-callback.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly whatsAppInboundService: WhatsAppInboundService,
    private readonly paymentService: PaymentService,
    private readonly dispatchService: DispatchService,
    private readonly twilioService: TwilioService,
  ) {}

  // Twilio WhatsApp webhook
  @Post('twilio')
  @Header('Content-Type', 'text/xml')
  async handleTwilioWebhook(@Body() body: Record<string, any>) {
    console.log('🔔 Twilio webhook received');
    return this.whatsAppInboundService.handleIncomingWhatsAppMessage(body);
  }

  /**
   * Twilio delivery-status callback — registered only as the
   * `statusCallback` on dispatch-offer sends (see
   * DispatchService.sendDispatchOfferMessage), never a Twilio
   * Console-level default, so no other send type reaches this route.
   * Validated the same way the callback URL was built at send time: the
   * exact `${API_BASE_URL}/api/v1/webhooks/twilio-status?offerId=...`
   * string, not whatever host/protocol this request happened to arrive
   * with — keeps validation correct regardless of a reverse proxy's
   * headers. Note the `/api/v1` — main.ts calls
   * app.setGlobalPrefix('api/v1'), so this route (like every route in the
   * app) is actually served under that prefix; a URL missing it both
   * 404s and fails signature verification even for a genuine request.
   */
  @Post('twilio-status')
  @HttpCode(200)
  async handleTwilioStatusCallback(
    @Query('offerId') offerId: string,
    @Body() body: TwilioStatusCallbackBody,
    @Headers('x-twilio-signature') signature: string,
  ) {
    const apiBaseUrl = process.env.API_BASE_URL;
    if (!apiBaseUrl) {
      // Multi-llm review: building the verification URL from an unset env
      // var produces a malformed string ("undefined/api/v1/...") that
      // Twilio SDK's validateRequest rejects via `new URL(...)` throwing —
      // an uncaught exception, not a clean error response. A genuine
      // Twilio request arriving against a misconfigured deploy should get
      // the same clean rejection shape as any other verification failure.
      console.error(
        '❌ Cannot verify Twilio status callback — API_BASE_URL is not set',
      );
      return { status: 'error', message: 'Service misconfigured' };
    }
    const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/twilio-status?offerId=${offerId}`;
    if (
      !this.twilioService.verifyStatusCallbackSignature(
        signature,
        url,
        body as Record<string, string>,
      )
    ) {
      console.error('❌ Invalid Twilio status callback signature');
      Sentry.captureMessage(
        'Invalid Twilio status callback signature received',
        'error',
      );
      return { status: 'error', message: 'Invalid signature' };
    }

    if (offerId && body.MessageSid && body.MessageStatus) {
      // Twilio's ErrorCode is a numeric string ("63024"), but it's still
      // attacker/proxy-reachable input before it hits an `Int` column —
      // Number('') is 0 and Number('abc') is NaN, neither a code Twilio
      // ever sends, so only a genuinely finite parse is forwarded.
      const parsedErrorCode = body.ErrorCode
        ? Number(body.ErrorCode)
        : undefined;
      await this.dispatchService.handleDeliveryStatusUpdate(
        offerId,
        body.MessageSid,
        body.MessageStatus,
        Number.isFinite(parsedErrorCode) ? parsedErrorCode : undefined,
      );
    }

    return { status: 'ok' };
  }

  // Paystack webhook
  @Post('paystack')
  @HttpCode(200)
  async handlePaystackWebhook(
    @Body() body: any,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ) {
    console.log('🔔 Paystack webhook received');
    console.log('Body:', JSON.stringify(body, null, 2));
    console.log('Signature:', signature);

    // Verify against the exact request bytes Paystack signed — re-serializing
    // the parsed body (JSON.stringify(body)) does not reliably reproduce
    // Paystack's original payload, so that comparison fails signatures that
    // are actually valid.
    if (
      !req.rawBody ||
      !this.paymentService.verifyWebhookSignature(req.rawBody, signature)
    ) {
      console.error('❌ Invalid Paystack webhook signature');
      Sentry.captureMessage(
        'Invalid Paystack webhook signature received',
        'error',
      );
      return { status: 'error', message: 'Invalid signature' };
    }

    console.log('✅ Paystack webhook signature verified');
    console.log('Processing event:', body.event);

    return this.paymentService.handlePaystackWebhook(body);
  }
}
