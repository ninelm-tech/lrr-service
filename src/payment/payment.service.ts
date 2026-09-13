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
 * References predating the payment model look like `DEP_<timestamp>_<rand>`
 * and will not match any row. That is handled, not an error: those requests
 * still complete through the business side effects below, which key on
 * RescueRequest.depositReference and are untouched by this task.
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
        await this.settle(
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

        const { reference, metadata } = data;

        if (metadata?.type === 'deposit') {
          await this.paymentEventsService.handleDepositPaymentConfirmed(
            reference!,
          );
        } else if (metadata?.type === 'balance') {
          await this.paymentEventsService.handleBalancePaymentConfirmed(
            reference!,
          );
        } else {
          console.warn('⚠️ Unknown charge metadata type:', metadata?.type);
          Sentry.captureMessage(
            `Paystack charge.success with unknown metadata type: ${metadata?.type}`,
            'warning',
          );
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
        await this.settle(
          () => this.findByReference(data.reference),
          mapTransferStatus(status),
          {
            providerRef: data.transfer_code
              ? `trf:${data.transfer_code}`
              : undefined,
            providerFee: data.fee_charged,
          },
          event,
        );

        if (event === 'transfer.success') {
          await this.payoutService.confirmTransferOutcome(
            data.transfer_code!,
            'SUCCESS',
          );
        } else {
          // The reason only belongs on a failure — passing it on success
          // would record a failureReason for a transfer that worked.
          await this.payoutService.confirmTransferOutcome(
            data.transfer_code!,
            'FAILED',
            data.reason,
          );
        }
        break;
      }

      // ── Refund outcome ────────────────────────────────────────────────────
      // New here. A code comment elsewhere claimed these were handled; they
      // were not, which is why a completed refund never left PENDING.
      case 'refund.processed':
      case 'refund.failed': {
        const status = event === 'refund.processed' ? 'processed' : 'failed';
        const payment = await this.settle(
          () => this.findRefund(data),
          mapRefundStatus(status),
          {
            providerRef:
              data.id !== undefined ? `refund:${data.id}` : undefined,
          },
          event,
        );

        if (payment) {
          // The request-level status the admin list reads. Nothing has ever
          // written COMPLETED before this, so every finished refund sat at
          // PENDING forever.
          await this.prisma.rescueRequest
            .update({
              where: { id: payment.rescueRequestId },
              data: {
                depositRefundStatus:
                  status === 'processed' ? 'COMPLETED' : 'FAILED',
              },
            })
            .catch((err: unknown) => {
              Sentry.captureException(err, {
                extra: {
                  rescueRequestId: payment.rescueRequestId,
                  reason: 'refund webhook could not update depositRefundStatus',
                },
              });
            });
        }
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
   * merely when one was found. A caller that cascades a request-level status
   * off the return value (refunds do, onto depositRefundStatus) must not run
   * that cascade for a lost race or a redelivered webhook arriving after the
   * row already moved to a DIFFERENT terminal state: claimTerminal's WHERE
   * only matches SUBMITTED/BLOCKED, so a row already FAILED stays FAILED
   * while the caller would otherwise still write COMPLETED over it.
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
