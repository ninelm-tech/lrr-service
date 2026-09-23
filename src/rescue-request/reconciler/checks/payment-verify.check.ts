import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import {
  Payment,
  PaymentStatus,
  PaymentType,
  RescueRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaystackService } from '../../../integrations/paystack/paystack.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { PaymentLedgerService } from '../../../payment/payment-ledger.service';
import { PaystackCustomerService } from '../../../payment/paystack-customer.service';
import {
  mapRefundStatus,
  mapTransactionStatus,
  mapTransferStatus,
} from '../../../payment/domain/paystack-status';
import { isDuplicateReference } from '../../../payment/domain/duplicate-reference';
import { MAX_VERIFY_ATTEMPTS } from '../../../payment/payment.constants';
import {
  PaystackRefundResult,
  PaystackTransferResult,
} from '../../../integrations/paystack/dto/paystack-outcome.dto';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { ReconcilerCheck } from '../reconciler-check.interface';
import { PaymentEventsService } from '../../payment-events.service';
import { PayoutService } from '../../../payout/payout.service';
import { classifyTransferValidationRejection } from '../../../payout/domain/paystack-transfer-validation';

/**
 * Chases every `Payment` row whose work is overdue: a `PENDING` row nobody
 * ever submitted, or a `SUBMITTED` row nobody has heard back from.
 *
 * `BLOCKED` is deliberately absent from the query — see *Actionable
 * non-terminal states* in the design doc. Nothing this check can do moves a
 * `BLOCKED` row; only a human, via `unblock`, can.
 *
 * The two branches need opposite treatment. `PENDING` means the process died
 * between the INSERT and the CAS, so no call was ever made — verifying it
 * would ask Paystack about a reference it has never heard of. `SUBMITTED`
 * means the call happened and the response — or its webhook — was lost, so
 * the only question is what actually happened at Paystack.
 *
 * This is the check that would have surfaced the live stuck-payout bug on
 * its own, about a minute after it stuck.
 */
@Injectable()
export class PaymentVerifyCheck implements ReconcilerCheck {
  readonly name = 'payment-verify';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly paymentLedger: PaymentLedgerService,
    private readonly paymentEventsService: PaymentEventsService,
    private readonly payoutService: PayoutService,
    private readonly paystackCustomerService: PaystackCustomerService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.payment.findMany({
      where: {
        status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED] },
        verifyAfter: { lt: now },
      },
      select: { id: true, status: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const row of due) {
      try {
        if (row.status === PaymentStatus.PENDING) {
          await this.initiate(row.id, now);
        } else {
          await this.verify(row.id, now);
        }
        acted += 1;
      } catch (error) {
        console.error(
          `PaymentVerifyCheck: failed to process payment ${row.id}:`,
          error,
        );
        Sentry.captureException(error, { extra: { paymentId: row.id } });
      }
    }
    return acted;
  }

  // ── PENDING: no call was ever made ──────────────────────────────────────

  private async initiate(paymentId: string, now: Date): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) return; // gone — nothing to recover

    // The same CAS as the normal path, pushing verifyAfter out before the
    // call. Returns false if something else already claimed it.
    if (!(await this.paymentLedger.claimForSubmission(paymentId, now))) {
      return;
    }

    switch (payment.type) {
      case PaymentType.DEPOSIT:
      case PaymentType.BALANCE:
        await this.initiateCollection(payment);
        return;
      case PaymentType.PAYOUT:
        await this.initiatePayout(payment);
        return;
      case PaymentType.REFUND:
        await this.initiateRefund(payment);
        return;
    }
  }

  /**
   * For a collection, initiating is not enough — the link has to reach the
   * motorist. A recovered DEPOSIT/BALANCE that stores nothing and sends
   * nothing has created a transaction the customer cannot pay: worse than
   * the crash, because the row now looks healthy.
   */
  private async initiateCollection(payment: Payment): Promise<void> {
    const request = await this.prisma.rescueRequest.findUnique({
      where: { id: payment.rescueRequestId },
      include: { customer: true },
    });
    if (!request) {
      this.escalate(payment, 'recovered collection has no rescue request');
      return;
    }
    if (!request.customer.phoneNumber) {
      // Every normal path validates this before a deposit/balance payment is
      // ever created — see assignOperator. A row reaching recovery without
      // it is a data problem this check cannot fix by waiting.
      this.escalate(
        payment,
        'recovered collection customer has no phone number',
      );
      return;
    }

    const isDeposit = payment.type === PaymentType.DEPOSIT;
    if (isDeposit && !request.assignedOperatorId) {
      this.escalate(payment, 'recovered deposit has no assigned operator');
      await this.paymentLedger.recordRejection(
        payment.id,
        'Cannot initiate deposit before an operator is assigned',
      );
      return;
    }

    // Never build the identity email inline — see PaystackCustomerService.
    const { email } = await this.paystackCustomerService.customerFor(
      request.customerId,
    );
    const reference = this.paymentLedger.referenceFor(payment);

    const result = await this.paystackService.initializePayment({
      email,
      amount: payment.amount,
      reference,
      metadata: {
        rescueRequestId: request.id,
        customerId: request.customerId,
        phoneNumber: request.customer.phoneNumber,
        type: isDeposit ? 'deposit' : 'balance',
      },
    });

    if (result.outcome === 'ambiguous') return; // stays SUBMITTED
    if (result.outcome === 'rejected') {
      await this.paymentLedger.recordRejection(
        payment.id,
        result.message ?? 'initialize rejected',
      );
      return;
    }

    const checkoutUrl = result.data.authorization_url;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutUrl },
    });

    // Deposits alone get a reminder-friendly URL column; a balance link is
    // only ever sent once, never resent from a stored copy. Neither type
    // needs its reference written anywhere else any more — the webhook and
    // this check both find the request via the Payment row's own
    // rescueRequestId, not by looking a reference up on RescueRequest.
    if (isDeposit) {
      await this.prisma.rescueRequest.update({
        where: { id: request.id },
        data: { depositPaymentUrl: checkoutUrl },
      });
    }

    if (request.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(request.customer.phoneNumber),
        `We're ready for your ${isDeposit ? 'deposit' : 'balance'} payment — tap the link below:\n\n👉 ${checkoutUrl}`,
      );
    }
  }

  /**
   * There is nobody to send anything to, so initiating is the whole job.
   *
   * Reaching PENDING for a payout means `PayoutService`'s own guards
   * (bank details, platform balance) already passed before the row was
   * created — this only needs to submit the transfer.
   */
  private async initiatePayout(payment: Payment): Promise<void> {
    const operator = payment.operatorId
      ? await this.prisma.operator.findUnique({
          where: { id: payment.operatorId },
        })
      : null;
    if (!operator?.paystackRecipientCode) {
      this.escalate(payment, 'recovered payout has no recipient code');
      return;
    }

    const result = await this.paystackService.initiateTransfer({
      recipientCode: operator.paystackRecipientCode,
      amount: payment.amount,
      reference: this.paymentLedger.referenceFor(payment),
      reason: `Job payout — ${payment.rescueRequestId}`,
    });
    await this.applyTransferResult(payment, result);
  }

  private async initiateRefund(payment: Payment): Promise<void> {
    // The original transaction to refund is the sibling deposit's OWN
    // reference — there is no RescueRequest column for this any more (see
    // refundDeposit, which reaches this same state before ever creating the
    // REFUND row, so a succeeded deposit is guaranteed to exist here too).
    const depositPayment = await this.prisma.payment.findFirst({
      where: {
        rescueRequestId: payment.rescueRequestId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.SUCCEEDED,
      },
    });
    if (!depositPayment) {
      this.escalate(
        payment,
        'recovered refund has no succeeded deposit to refund against',
      );
      return;
    }

    const result = await this.paystackService.refundTransaction({
      transaction: this.paymentLedger.referenceFor(depositPayment),
      amount: payment.amount,
      merchantNote: payment.id,
    });
    await this.applyRefundResult(payment.id, result);
  }

  // ── SUBMITTED: the call happened, the answer didn't arrive ──────────────

  private async verify(paymentId: string, now: Date): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    // A webhook may have settled this since the query ran — nothing to do.
    if (!payment || payment.status !== PaymentStatus.SUBMITTED) return;

    switch (payment.type) {
      case PaymentType.DEPOSIT:
      case PaymentType.BALANCE:
        await this.verifyCollection(payment, now);
        return;
      case PaymentType.PAYOUT:
        await this.verifyPayout(payment, now);
        return;
      case PaymentType.REFUND:
        await this.verifyRefund(payment, now);
        return;
    }
  }

  /**
   * The unpayable-collection rule. A `SUBMITTED` collection needs more than
   * "not found or not": the checkout URL lives only in the initialize
   * response, and Paystack will not issue a second one for an existing
   * reference, so a lost response leaves a transaction nobody can pay.
   * Polling it forever is exactly the stranded state this check removes.
   */
  private async verifyCollection(payment: Payment, now: Date): Promise<void> {
    const result = await this.paystackService.verifyTransaction(
      this.paymentLedger.referenceFor(payment),
    );

    if (result.outcome === 'ambiguous') {
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    if (result.outcome === 'rejected') {
      if (result.code === 'transaction_not_found') {
        // Paystack never heard of the reference: the POST did not land.
        // Nothing moved and no link exists. Failing is safe for inbound
        // money — a fresh attempt is correct.
        await this.paymentLedger.claimTerminal(payment.id, {
          status: PaymentStatus.FAILED,
        });
        return;
      }
      // An unexpected rejection code on a read. Wait rather than guess.
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    const mapped = mapTransactionStatus(result.data.status);
    if (mapped.status !== PaymentStatus.SUBMITTED) {
      // A real terminal answer — success/failed/reversed — decides this
      // regardless of whether we ever captured the checkout URL.
      const claimed = await this.paymentLedger.claimTerminal(
        payment.id,
        mapped,
        {
          providerRef: `txn:${result.data.id}`,
          providerFee: result.data.fees,
          netAmount:
            result.data.fees !== undefined
              ? result.data.amount - result.data.fees
              : undefined,
        },
      );
      // Only the caller whose claim actually won runs the business side
      // effects — the same rule as the webhook's own settle(). This is the
      // fix for the gap a webhook-only design would otherwise leave: a
      // payment settled by verification, rather than by a webhook, must
      // still assign the operator / complete the job, or the money lands
      // and the job never moves.
      if (claimed && mapped.status === PaymentStatus.SUCCEEDED) {
        const settled = { ...payment, ...mapped };
        if (payment.type === PaymentType.DEPOSIT) {
          await this.paymentEventsService.confirmDeposit(settled);
        } else {
          await this.paymentEventsService.confirmBalance(settled);
        }
      }
      return;
    }

    // Paystack has the transaction but it hasn't concluded — pending, or
    // abandoned (not paid YET, not terminal for a collection). What happens
    // next hinges on whether the customer could ever have received a link.
    if (payment.checkoutUrl === null) {
      // The create response was lost: unpayable by construction. Paystack
      // will not re-issue a URL for an existing reference, so nobody can
      // ever pay this attempt. Safe to fail — they cannot hold a link to
      // double-spend on.
      await this.paymentLedger.claimTerminal(payment.id, {
        status: PaymentStatus.FAILED,
      });
      return;
    }

    // Keep polling either way. Paystack won't reissue a URL for this
    // reference, so if the customer completes payment after their request
    // closed, we still need the poll (or the webhook, whichever arrives
    // first) to catch it and flag it for refund. NEVER fail this branch —
    // they could pay a link written off, leaving money received against a
    // dead row.
    //
    // What's NOT unconditional is telling them to pay.
    //
    // DEPOSIT never resends from here: deposit-reminder.check.ts already
    // owns the customer-facing reminder, on the correct 25/15/5-minutes-left
    // ladder tied to depositWindowExpiresAt. Resending here too was pure
    // duplication on an unrelated schedule (this check's own exponential
    // backoff from createdAt) — the source of near-duplicate messages
    // minutes apart during a perfectly normal, still-open window, and of
    // messages that kept going for hours after the window (and the request)
    // had already closed, since this schedule doesn't know about either.
    //
    // BALANCE has no equivalent ladder, so it keeps this as its only
    // reminder — but only while the request hasn't been CANCELLED. `cancel()`
    // has no status guard (see rescue-request-admin.service.ts), so a
    // COMPLETED request with a pending balance can be cancelled too, and
    // paying now wouldn't un-cancel it any more than a dead deposit would.
    if (payment.type === PaymentType.BALANCE) {
      const request = await this.prisma.rescueRequest.findUnique({
        where: { id: payment.rescueRequestId },
        select: { status: true },
      });
      if (request?.status !== RescueRequestStatus.CANCELLED) {
        await this.resendCheckoutLink(payment);
      }
    }
    await this.paymentLedger.backOff(payment.id, now);
  }

  private async resendCheckoutLink(payment: Payment): Promise<void> {
    if (!payment.checkoutUrl) return;
    const request = await this.prisma.rescueRequest.findUnique({
      where: { id: payment.rescueRequestId },
      include: { customer: true },
    });
    if (!request?.customer.phoneNumber) return;

    const label = payment.type === PaymentType.DEPOSIT ? 'deposit' : 'balance';
    try {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(request.customer.phoneNumber),
        `⚠️ We're still waiting on your ${label} payment — here's your link again:\n\n👉 ${payment.checkoutUrl}`,
      );
    } catch (error) {
      Sentry.captureException(error, {
        extra: { paymentId: payment.id, stage: 'payment-verify-resend' },
      });
    }
  }

  /**
   * A "not found" is never definitive for outbound money — it may be
   * Paystack's read lag, and concluding FAILED would send a fresh reference
   * for a transfer that already landed. Re-submitting the identical
   * reference is safe because Paystack rejects a genuine duplicate; that
   * rejection is itself the answer we were missing.
   */
  private async verifyPayout(payment: Payment, now: Date): Promise<void> {
    const result = await this.paystackService.verifyTransfer(
      this.paymentLedger.referenceFor(payment),
    );

    if (result.outcome === 'ambiguous') {
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    if (result.outcome === 'rejected') {
      if (result.code !== 'not_found') {
        // An unexpected rejection code on a read. Wait rather than guess.
        await this.paymentLedger.backOff(payment.id, now);
        return;
      }
      if (payment.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        this.escalate(payment, 'payout not found after max verify attempts');
        await this.paymentLedger.backOff(payment.id, now);
        return;
      }

      const operator = payment.operatorId
        ? await this.prisma.operator.findUnique({
            where: { id: payment.operatorId },
          })
        : null;
      if (!operator?.paystackRecipientCode) {
        this.escalate(payment, 'payout re-submission has no recipient code');
        await this.paymentLedger.backOff(payment.id, now);
        return;
      }

      const resubmit = await this.paystackService.initiateTransfer({
        recipientCode: operator.paystackRecipientCode,
        amount: payment.amount,
        reference: this.paymentLedger.referenceFor(payment),
        reason: `Job payout — ${payment.rescueRequestId}`,
      });
      const outcome = await this.applyTransferResult(payment, resubmit);
      if (outcome === 'pending')
        await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    const outcome = await this.applyTransferResult(payment, result);
    if (outcome === 'pending')
      await this.paymentLedger.backOff(payment.id, now);
  }

  /**
   * Classifies a transfer response and applies it to the ledger. Shared by
   * the PENDING branch's own first submission and the SUBMITTED branch's
   * not-found re-submission — both call `initiateTransfer` and must land on
   * the row the same way.
   *
   * Returns whether the row reached a stopping point. The caller decides
   * whether to back off: the PENDING branch's own CAS already pushed
   * `verifyAfter` out, so it never needs to; the SUBMITTED branch does.
   */
  private async applyTransferResult(
    payment: Payment,
    result: PaystackTransferResult,
  ): Promise<'settled' | 'pending'> {
    const paymentId = payment.id;
    if (result.outcome === 'ambiguous') return 'pending';
    if (result.outcome === 'rejected') {
      if (isDuplicateReference(result)) return 'pending';
      await this.paymentLedger.recordBlocked(
        paymentId,
        classifyTransferValidationRejection(result.code, result.message),
      );
      return 'settled';
    }

    // Best-effort context, not the state transition itself — a failure here
    // must not abort the classification below, which is what the row's
    // actual money-state depends on. Reported rather than swallowed: a
    // providerRef collision would mean something genuinely unexpected.
    await this.prisma.payment
      .update({
        where: { id: paymentId },
        data: { providerRef: `trf:${result.data.transfer_code}` },
      })
      .catch((error: unknown) => {
        Sentry.captureException(error, {
          extra: { paymentId, stage: 'payment-verify-transfer-providerRef' },
        });
      });

    const mapped = mapTransferStatus(result.data.status);
    if (mapped.status === PaymentStatus.BLOCKED) {
      await this.paymentLedger.recordBlocked(paymentId, mapped.blockReason!);
      return 'settled';
    }
    if (mapped.status !== PaymentStatus.SUBMITTED) {
      const claimed = await this.paymentLedger.claimTerminal(paymentId, mapped);
      // Same rule as the collection side: only the caller whose claim won
      // notifies the operator. The webhook path does this too
      // (payment.service.ts) — a payout resolved by this check instead of
      // a webhook must still tell the operator they've been paid.
      if (claimed && mapped.status === PaymentStatus.SUCCEEDED) {
        await this.payoutService.notifyPayoutOutcome({ ...payment, ...mapped });
      }
      return 'settled';
    }
    return 'pending';
  }

  /**
   * Refunds are the exception: read-only recovery, matched by
   * `merchant_note`, never re-submitted. The create endpoint takes no
   * reference of ours, so there is no duplicate for Paystack to reject — a
   * second POST is simply a second refund.
   */
  private async verifyRefund(payment: Payment, now: Date): Promise<void> {
    const deposit = await this.prisma.payment.findFirst({
      where: {
        rescueRequestId: payment.rescueRequestId,
        type: PaymentType.DEPOSIT,
        status: PaymentStatus.SUCCEEDED,
      },
    });
    if (!deposit) {
      // Should not be reachable: a REFUND row is only ever created after its
      // sibling deposit has already reached SUCCEEDED (refundDeposit's own
      // eligibility claim requires it). Waiting may still help if it somehow
      // is — its own webhook or verification could land before the next
      // pass — but not forever: escalate the same as any other stuck refund.
      if (payment.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        this.escalate(
          payment,
          'refund recovery: no succeeded deposit after max verify attempts',
        );
      }
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }
    if (!deposit.providerRef?.startsWith('txn:')) {
      // A succeeded deposit should always carry this — see PaymentService's
      // settle(). If it doesn't, no query against Paystack's refund list can
      // ever be built, and no amount of waiting fixes that.
      this.escalate(
        payment,
        'refund recovery: succeeded deposit has no providerRef',
      );
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }
    const transactionId = deposit.providerRef.replace('txn:', '');

    const listResult = await this.paystackService.listRefunds(transactionId);
    if (listResult.outcome === 'ambiguous') {
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    // Matching by note, not by existence: an earlier attempt we recorded as
    // FAILED may still have left a refund record at Paystack, so more than
    // one row can legitimately come back. Adopting an arbitrary one would
    // attach this attempt to somebody else's refund.
    const match = listResult.data.find((r) => r.merchant_note === payment.id);
    if (!match) {
      if (payment.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        this.escalate(
          payment,
          'refund recovery: no matching refund after max verify attempts',
        );
      }
      // Never re-submit — a second POST would issue a second refund.
      await this.paymentLedger.backOff(payment.id, now);
      return;
    }

    const outcome = await this.applyRefundResult(payment.id, {
      outcome: 'ok',
      data: { id: match.id, status: match.status },
    });
    if (outcome === 'pending')
      await this.paymentLedger.backOff(payment.id, now);
  }

  /**
   * Classifies a refund response and applies it to the ledger. Shared by the
   * PENDING branch's own create and the SUBMITTED branch's list-and-match —
   * both end up with the same `{id, status}` shape once a refund is in hand.
   *
   * Never called with `rejected` from the SUBMITTED path: a no-match there
   * stays SUBMITTED by construction, not rejected — see verifyRefund.
   */
  private async applyRefundResult(
    paymentId: string,
    result: PaystackRefundResult,
  ): Promise<'settled' | 'pending'> {
    if (result.outcome === 'ambiguous') return 'pending'; // never re-POST
    if (result.outcome === 'rejected') {
      await this.paymentLedger.recordRejection(
        paymentId,
        result.message ?? 'refund rejected',
      );
      return 'settled';
    }

    // Same trade-off as applyTransferResult: best-effort context, reported
    // rather than swallowed, and never allowed to block the classification.
    await this.prisma.payment
      .update({
        where: { id: paymentId },
        data: { providerRef: `refund:${result.data.id}` },
      })
      .catch((error: unknown) => {
        Sentry.captureException(error, {
          extra: { paymentId, stage: 'payment-verify-refund-providerRef' },
        });
      });

    const mapped = mapRefundStatus(result.data.status);
    if (mapped.status === PaymentStatus.BLOCKED) {
      await this.paymentLedger.recordBlocked(paymentId, mapped.blockReason!);
      return 'settled';
    }
    if (mapped.status !== PaymentStatus.SUBMITTED) {
      await this.paymentLedger.claimTerminal(paymentId, mapped);
      return 'settled';
    }
    return 'pending';
  }

  private escalate(
    payment: { id: string; rescueRequestId: string },
    reason: string,
  ): void {
    Sentry.captureMessage(`PaymentVerifyCheck: ${reason}`, {
      level: 'error',
      extra: {
        paymentId: payment.id,
        rescueRequestId: payment.rescueRequestId,
      },
    });
  }
}
