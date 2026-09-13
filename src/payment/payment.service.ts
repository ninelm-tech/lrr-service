import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { Payment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentEventsService } from '../rescue-request/payment-events.service';
import { PayoutService } from '../payout/payout.service';
import { PaymentLedgerService } from './payment-ledger.service';
import {
  MappedStatus,
  mapRefundStatus,
  mapTransactionStatus,
  mapTransferStatus,
} from './domain/paystack-status';
import {
  PaystackWebhookBody,
  PaystackWebhookData,
} from './dto/paystack-webhook.dto';

/**
 * Our reference format, reversed. `DEP_`/`BAL_` are collections and `payout_`
 * is a transfer; everything after the underscore is the Payment id.
 *
 * Every live reference now has a Payment row — the old RescueRequest columns
 * a legacy reference would have matched against are gone (Task 11), so a
 * miss here is a genuine anomaly rather than a tolerated transition case.
 */
const REFERENCE_PATTERN = /^(?:DEP|BAL|payout)_(.+)$/;

@Injectable()
export class PaymentService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => PaymentEventsService))
    private readonly paymentEventsService: PaymentEventsService,
    @Inject(forwardRef(() => PayoutService))
    private readonly payoutService: PayoutService,
    private readonly prisma: PrismaService,
    private readonly paymentLedger: PaymentLedgerService,
  ) {}

  /**
   * Verify a Paystack webhook signature against the exact request bytes
   * Paystack signed. Must be the raw body (Buffer/string) — re-serializing
   * the parsed JSON object does not reliably reproduce the original bytes
   * (key order, number formatting), so that comparison silently rejects
   * genuine webhooks.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    const secretKey =
      this.configService.get<string>('PAYSTACK_SECRET_KEY') || '';
    const hash = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');
    return hash === signature;
  }

  /**
   * Central Paystack webhook dispatcher.
   * All events from Paystack come here.
   *
   * Each case does two things: settles the Payment row, then runs the
   * business side effects that already existed. The bookkeeping goes first
   * but can never break the flow — see settle().
   */
  async handlePaystackWebhook(body: PaystackWebhookBody) {
    const event = body.event;
    const data = body.data ?? {};

    console.log('📨 Paystack webhook event:', event);

    switch (event) {
      // ── One-off charge (deposit or balance payment) ─────────────────────
      case 'charge.success': {
        // The transaction id recorded here is what refund recovery reads
        // back off the deposit row to list refunds against.
        const payment = await this.settle(
          () => this.findByReference(data.reference),
          mapTransactionStatus('success'),
          {
            providerRef: data.id !== undefined ? `txn:${data.id}` : undefined,
            providerFee: data.fees,
            netAmount:
              data.amount !== undefined
                ? data.amount - (data.fees ?? 0)
                : undefined,
          },
          event,
        );
        if (!payment) break;

        // settle() returns the PRE-claim object — its .status still reads
        // SUBMITTED. Neither confirmDeposit/confirmBalance reads .status
        // today, but passing the object claimTerminal actually produced
        // (rather than the one it was given) is the same discipline
        // applied to the transfer case below, and keeps this from becoming
        // a trap for whichever one of them checks status next.
        const settled = { ...payment, status: 'SUCCEEDED' as const };

        // The Payment row's OWN type, not the webhook's echoed-back
        // metadata — metadata is client-supplied and only ever meant for
        // humans reading the Paystack dashboard, not a thing to branch on
        // when we already have our own authoritative record of what this is.
        if (payment.type === 'DEPOSIT') {
          await this.paymentEventsService.confirmDeposit(settled);
        } else if (payment.type === 'BALANCE') {
          await this.paymentEventsService.confirmBalance(settled);
        }
        break;
      }

      // ── Operator payout transfer outcome ──────────────────────────────────
      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed': {
        // The event name is the status; the body's own field is not trusted
        // to agree with it.
        const status = event.slice('transfer.'.length);
        const mapped = mapTransferStatus(status);
        const payment = await this.settle(
          () => this.findByReference(data.reference),
          mapped,
          {
            providerRef: data.transfer_code
              ? `trf:${data.transfer_code}`
              : undefined,
            providerFee: data.fee_charged,
          },
          event,
        );

        // payment truthy means THIS call settled it; mapped.status is what
        // it was settled TO — payment.status itself is still the stale
        // pre-claim value, so notifyPayoutOutcome (which reads .status) must
        // be given the settled value, not the object settle() found. Only a
        // genuine success notifies the operator, matching pre-Task-11.
        if (payment && mapped.status === 'SUCCEEDED') {
          await this.payoutService.notifyPayoutOutcome({
            ...payment,
            ...mapped,
          });
        }
        break;
      }

      // ── Refund outcome ────────────────────────────────────────────────────
      case 'refund.processed':
      case 'refund.failed': {
        const status = event === 'refund.processed' ? 'processed' : 'failed';
        // The request-level refund status the admin list reads is now fully
        // derived from this Payment row's own status (see
        // domain/derive-payment-state.ts) — settling it here is the whole job.
        await this.settle(
          () => this.findRefund(data),
          mapRefundStatus(status),
          {
            providerRef:
              data.id !== undefined ? `refund:${data.id}` : undefined,
          },
          event,
        );
        break;
      }

      default:
        console.log('⏭️ Unhandled Paystack event:', event);
    }

    return { status: 'success' };
  }

  /**
   * Settle one payment from a webhook, and never throw.
   *
   * Bookkeeping must not be able to break the customer-visible flow that
   * follows it: a payment left unsettled is recoverable by PaymentVerifyCheck,
   * whereas a notification never sent is not.
   *
   * A payment that cannot be found is logged and skipped rather than treated
   * as an error — legacy references, and refunds whose create response was
   * lost, both land here legitimately.
   *
   * Returns the payment only when THIS call's claim actually won — never
   * merely when one was found. Both callers that act on the return value
   * (confirmDeposit/confirmBalance, and notifyPayoutOutcome) must not run for
   * a lost race or a redelivered webhook arriving after the row already
   * moved to a terminal state: claimTerminal's WHERE only matches
   * SUBMITTED/BLOCKED, so a second arrival correctly finds nothing left to
   * claim, and the caller must skip its side effect rather than repeat it.
   */
  private async settle(
    find: () => Promise<Payment | null>,
    mapped: MappedStatus,
    fields: { providerRef?: string; providerFee?: number; netAmount?: number },
    event: string,
  ): Promise<Payment | null> {
    try {
      const payment = await find();
      if (!payment) {
        console.warn(`⚠️ ${event}: no Payment row matched`);
        return null;
      }

      // The guard is the query. A webhook and a verification will race for
      // the same row, and whichever is second claims nothing — that is the
      // normal case, not an edge case, so a false return is not an error,
      // but it does mean THIS call did not settle anything.
      const claimed = await this.paymentLedger.claimTerminal(
        payment.id,
        mapped,
        fields,
      );
      return claimed ? payment : null;
    } catch (err) {
      Sentry.captureException(err, {
        extra: { event, reason: 'payment bookkeeping failed in webhook' },
      });
      return null;
    }
  }

  /** Charges and transfers: our own reference carries the Payment id. */
  private async findByReference(
    reference: string | undefined,
  ): Promise<Payment | null> {
    const id = REFERENCE_PATTERN.exec(reference ?? '')?.[1];
    if (!id) return null;
    return this.prisma.payment.findUnique({ where: { id } });
  }

  /**
   * Refunds carry no reference of ours, so they are found by the id written
   * when the create response came back, and failing that by the
   * `merchant_note` we set to the bare Payment.id at create time.
   *
   * The note is the fallback rather than the primary because providerRef is
   * unique and indexed; the note is what survives a lost create response.
   */
  private async findRefund(data: PaystackWebhookData): Promise<Payment | null> {
    if (data.id !== undefined) {
      const byRef = await this.prisma.payment.findUnique({
        where: { providerRef: `refund:${data.id}` },
      });
      if (byRef) return byRef;
    }
    if (data.merchant_note) {
      const byNote = await this.prisma.payment.findUnique({
        where: { id: data.merchant_note },
      });
      // Guard the type: merchant_note is free text at Paystack, and matching
      // it against an id must not let some other payment be settled as a
      // refund.
      if (byNote?.type === 'REFUND') return byNote;
    }
    return null;
  }
}
