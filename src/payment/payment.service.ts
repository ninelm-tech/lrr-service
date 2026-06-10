import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { RescueRequestService } from '../rescue-request/rescue-request.service';
import { SubscriptionService } from '../subscription/subscription.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => RescueRequestService))
    private readonly rescueRequestService: RescueRequestService,
    @Inject(forwardRef(() => SubscriptionService))
    private readonly subscriptionService: SubscriptionService,
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
   * Central Paystack webhook dispatcher.
   * All events from Paystack come here — both deposit/balance and subscription events.
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
          await this.rescueRequestService.handleDepositPaymentConfirmed(reference);

        } else if (metadata?.type === 'balance') {
          await this.rescueRequestService.handleBalancePaymentConfirmed(reference);

        } else if (metadata?.type === 'subscription_init') {
          // First charge of a plan subscription — Paystack fires charge.success here,
          // NOT invoice.payment_success (that's mainly renewals). Activate now.
          await this.subscriptionService.handleSubscriptionInitCharge(data);

        } else {
          console.warn('⚠️ Unknown charge metadata type:', metadata?.type);
          Sentry.captureMessage(`Paystack charge.success with unknown metadata type: ${metadata?.type}`, 'warning');
        }
        break;
      }

      // ── Subscription renewal / first activation ──────────────────────────
      case 'invoice.payment_success': {
        await this.subscriptionService.handleInvoicePaymentSuccess(data);
        break;
      }

      // ── Subscription cancelled by customer on Paystack side ──────────────
      case 'subscription.not_renew':
      case 'subscription.disable': {
        await this.subscriptionService.handleSubscriptionExpired(data);
        break;
      }

      // ── Renewal payment failed ───────────────────────────────────────────
      case 'invoice.payment_failed': {
        await this.subscriptionService.handleSubscriptionExpired(data);
        break;
      }

      // ── Subscription created on Paystack side ────────────────────────────
      case 'subscription.create': {
        // Store the subscription_code so we can cancel/manage it later.
        await this.subscriptionService.handleSubscriptionCreate(data);
        break;
      }

      default:
        console.log('⏭️ Unhandled Paystack event:', event);
    }

    return { status: 'success' };
  }
}
