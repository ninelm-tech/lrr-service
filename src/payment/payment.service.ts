import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RescueRequestService } from '../rescue-request/rescue-request.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly configService: ConfigService,
    private readonly rescueRequestService: RescueRequestService,
  ) {}

  /**
   * Verify Paystack webhook signature
   */
  verifyWebhookSignature(body: any, signature: string): boolean {
    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY') || '';
    const hash = crypto
      .createHmac('sha512', secretKey)
      .update(JSON.stringify(body))
      .digest('hex');

    return hash === signature;
  }

  /**
   * Handle Paystack webhook events
   */
  async handlePaystackWebhook(body: any) {
    const event = body.event;
    const data = body.data;

    console.log('Processing Paystack event:', event);

    if (event === 'charge.success') {
      const reference = data.reference;
      const metadata = data.metadata;

      if (metadata?.type === 'deposit') {
        await this.rescueRequestService.handleDepositPaymentConfirmed(reference);
      } else if (metadata?.type === 'balance') {
        // Future: handle balance payment
        console.log('Balance payment received:', reference);
      }
    }

    return { status: 'success' };
  }
}
