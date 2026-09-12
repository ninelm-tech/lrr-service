import { Body, Controller, Post, Header, Headers, HttpCode, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';
import { WhatsAppInboundService } from '../rescue-request/whatsapp-inbound.service';
import { PaymentService } from '../payment/payment.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly whatsAppInboundService: WhatsAppInboundService,
    private readonly paymentService: PaymentService,
  ) {}

  // Twilio WhatsApp webhook
  @Post('twilio')
  @Header('Content-Type', 'text/xml')
  async handleTwilioWebhook(@Body() body: Record<string, any>) {
    console.log('🔔 Twilio webhook received');
    return this.whatsAppInboundService.handleIncomingWhatsAppMessage(body);
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
    if (!req.rawBody || !this.paymentService.verifyWebhookSignature(req.rawBody, signature)) {
      console.error('❌ Invalid Paystack webhook signature');
      Sentry.captureMessage('Invalid Paystack webhook signature received', 'error');
      return { status: 'error', message: 'Invalid signature' };
    }

    console.log('✅ Paystack webhook signature verified');
    console.log('Processing event:', body.event);

    return this.paymentService.handlePaystackWebhook(body);
  }

  // Test endpoint - manually trigger webhook for testing
  @Post('paystack/test')
  @HttpCode(200)
  async testPaystackWebhook() {
    console.log('🧪 Testing Paystack webhook handler');
    
    // Use a real reference from your database for testing
    // You'll need to replace this with an actual reference
    const testReference = 'DEP_1778031930959_zoo6eh7'; // Replace with your actual reference
    
    await this.paymentService.handlePaystackWebhook({
      event: 'charge.success',
      data: {
        reference: testReference,
        status: 'success',
        amount: 500000,
        metadata: {
          type: 'deposit',
        },
      },
    });

    return { status: 'success', message: 'Test webhook processed' };
  }
}
