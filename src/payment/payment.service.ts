import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { PaymentEventsService } from '../rescue-request/payment-events.service';
import { PayoutService } from '../payout/payout.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => PaymentEventsService))
    private readonly paymentEventsService: PaymentEventsService,
    private readonly payoutService: PayoutService,
  ) {}

  /**
   * Verify a Paystack webhook signature against the exact request bytes
   * Paystack signed. Must be the raw body (Buffer/string) — re-serializing
   * the parsed JSON object does not reliably reproduce the original bytes
   * (key order, number formatting), so that comparison silently rejects
   * genuine webhooks.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY') || '';
    const hash = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');
    return hash === signature;
  }

  /**
   * Central Paystack webhook dispatcher.
   * All events from Paystack come here.
   */
  async handlePaystackWebhook(body: any) {
    const event = body.event;
    const data  = body.data;

    console.log('📨 Paystack webhook event:', event);

    switch (event) {

      // ── One-off charge (deposit or balance payment) ─────────────────────
      case 'charge.success': {
        const { reference, metadata } = data;

        if (metadata?.type === 'deposit') {
          await this.paymentEventsService.handleDepositPaymentConfirmed(reference);

        } else if (metadata?.type === 'balance') {
          await this.paymentEventsService.handleBalancePaymentConfirmed(reference);

        } else {
          console.warn('⚠️ Unknown charge metadata type:', metadata?.type);
          Sentry.captureMessage(`Paystack charge.success with unknown metadata type: ${metadata?.type}`, 'warning');
        }
        break;
      }

      // ── Operator payout transfer outcome ──────────────────────────────────
      case 'transfer.success': {
        await this.payoutService.confirmTransferOutcome(data.transfer_code, 'SUCCESS');
        break;
      }

      case 'transfer.failed':
      case 'transfer.reversed': {
        await this.payoutService.confirmTransferOutcome(data.transfer_code, 'FAILED', data.reason);
        break;
      }

      default:
        console.log('⏭️ Unhandled Paystack event:', event);
    }

    return { status: 'success' };
  }
}
