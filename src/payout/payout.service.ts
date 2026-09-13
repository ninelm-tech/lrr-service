import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import {
  Payment,
  PaymentBlockReason,
  PaymentStatus,
  PayoutStatus,
  PayoutBlockReason,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { mapTransferStatus } from '../payment/domain/paystack-status';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from '../rescue-request/domain/rescue-request-formatting';

/**
 * A duplicate-reference rejection is evidence the original transfer LANDED —
 * the opposite of a failure. Marking it FAILED would make a fresh row and a
 * fresh reference legal, which is the double-pay this design exists to
 * prevent.
 *
 * Matches the provider code and falls back to the message, so a wording
 * change on Paystack's side cannot silently turn a duplicate into a
 * rejection.
 */
function isDuplicateReference(r: { code?: string; message?: string }): boolean {
  if (r.code === 'duplicate_reference') return true;
  return /reference.*(already|used|exist)/i.test(r.message ?? '');
}

/**
 * The two block reasons we cause ourselves. Nothing was ever sent to
 * Paystack, so the attempt can legitimately resume on the SAME row — see
 * claimPayoutPayment. The other two (AWAITING_OTP, NEEDS_CUSTOMER_DETAILS)
 * mean the money movement already exists provider-side and must never be
 * re-submitted.
 */
const OUR_OWN_BLOCKS: PaymentBlockReason[] = [
  PaymentBlockReason.NO_BANK_DETAILS,
  PaymentBlockReason.INSUFFICIENT_BALANCE,
];

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly paymentLedger: PaymentLedgerService,
  ) {}

  /**
   * Create a Payout row for a completed job and attempt to process it
   * immediately. Never throws — every failure path is caught and reflected
   * in the Payout row's status/blockReason/failureReason instead, since
   * this is called from handleBalancePaymentConfirmed and must not disrupt
   * the customer/operator notification flow around it.
   */
  async createAndProcessPayout(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
  ): Promise<void> {
    let payoutId: string;
    try {
      const payout = await this.prisma.payout.create({
        data: { rescueRequestId, operatorId, amount },
      });
      payoutId = payout.id;
    } catch (err) {
      console.error('❌ Failed to create payout record:', err);
      Sentry.captureException(err);
      return;
    }

    await this.attemptPayout(payoutId, operatorId, amount, rescueRequestId);
  }

  /**
   * Re-run a blocked (PENDING) or FAILED payout — admin-triggered only.
   *
   * Only those two states may be retried. Retrying a SUCCESS payout would
   * initiate a SECOND real Paystack transfer and pay the operator twice;
   * retrying PROCESSING would duplicate a transfer already in flight. The
   * Payouts tab hides the Retry button for those rows, but a hidden button
   * is not a safeguard — a direct API call or a UI regression would still
   * move real money, so the rule is enforced here.
   *
   * The state transition is an atomic conditional update rather than a
   * read-then-check, so two admins clicking Retry simultaneously can't both
   * pass the check and fire two transfers. Whoever claims the row proceeds;
   * the other gets the same rejection as any other non-retryable status.
   *
   * Trade-off worth knowing: if the process dies between claiming the row
   * and attemptPayout resolving, the payout is stranded in PROCESSING with
   * no transfer code and can't be retried without manual intervention.
   * That's deliberate — a stuck row loses no money, a double transfer does.
   *
   * Returns the payout's resulting state so the caller can report what
   * actually happened. A retry that immediately re-blocks (e.g. the
   * operator still has no bank details) is a legitimate outcome, not a
   * success — reporting it as "retry initiated" tells an admin the
   * opposite of the truth.
   */
  async retryPayout(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    const claimed = await this.prisma.payout.updateMany({
      where: {
        id: payoutId,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.FAILED] },
      },
      data: { status: PayoutStatus.PROCESSING },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        `Only blocked or failed payouts can be retried — this one is ${payout.status}.`,
      );
    }

    await this.attemptPayout(
      payoutId,
      payout.operatorId,
      payout.amount,
      payout.rescueRequestId,
    );
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }

  /**
   * The ledger row for this attempt, claimed and ready to submit.
   *
   * A retry reuses whatever its previous attempt left in flight rather than
   * inserting a sibling: the in-flight partial unique index permits only one,
   * and for the two blocks we cause ourselves the row never reached Paystack,
   * so returning it to SUBMITTED is safe and keeps the reference stable.
   *
   * Returns null when this attempt must not proceed — the row is already at
   * Paystack (SUBMITTED, or BLOCKED awaiting a human there), or another
   * caller won the claim. **A null means do not call Paystack.**
   */
  private async claimPayoutPayment(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
  ): Promise<Payment | null> {
    const existing = await this.prisma.payment.findFirst({
      where: {
        rescueRequestId,
        type: 'PAYOUT',
        status: {
          in: [
            PaymentStatus.PENDING,
            PaymentStatus.SUBMITTED,
            PaymentStatus.BLOCKED,
          ],
        },
      },
    });

    if (!existing) {
      let created: Payment;
      try {
        created = await this.paymentLedger.create({
          rescueRequestId,
          type: 'PAYOUT',
          amount,
          operatorId,
        });
      } catch {
        // The index refused it: a concurrent attempt inserted between our
        // read and our write. That attempt owns the payout, not us.
        return null;
      }
      return (await this.paymentLedger.claimForSubmission(
        created.id,
        new Date(),
      ))
        ? created
        : null;
    }

    if (existing.status === PaymentStatus.PENDING) {
      return (await this.paymentLedger.claimForSubmission(
        existing.id,
        new Date(),
      ))
        ? existing
        : null;
    }

    if (
      existing.status === PaymentStatus.BLOCKED &&
      existing.blockReason &&
      OUR_OWN_BLOCKS.includes(existing.blockReason)
    ) {
      return (await this.paymentLedger.unblock(existing.id, new Date()))
        ? existing
        : null;
    }

    return null;
  }

  /**
   * Record a block we caused ourselves, on a row that never reached Paystack.
   *
   * Silently does nothing if a real transfer is in flight for this request —
   * overwriting a SUBMITTED row with a block would lose track of money that
   * is actually moving.
   */
  private async blockPayment(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
    reason: PaymentBlockReason,
  ): Promise<void> {
    const payment = await this.claimPayoutPayment(
      rescueRequestId,
      operatorId,
      amount,
    );
    if (!payment) return;
    await this.paymentLedger.recordBlocked(payment.id, reason);
  }

  /**
   * Never creates a Paystack recipient here — that only happens once,
   * synchronously, inside OperatorService.saveBankDetails (the one place
   * the full account number is ever available). This method only ever
   * consumes an already-existing paystackRecipientCode.
   *
   * The Payout row is still written and transitioned alongside the Payment
   * row — the additive-migration rule. Every branch below that moves one
   * moves the other. Task 11 deletes the table and its readers together.
   */
  private async attemptPayout(
    payoutId: string,
    operatorId: string,
    amount: number,
    rescueRequestId: string,
  ): Promise<void> {
    try {
      const operator = await this.prisma.operator.findUnique({
        where: { id: operatorId },
      });
      if (!operator?.paystackRecipientCode) {
        // Conditional write, not read-then-write: two concurrent attempts
        // must not both observe "not yet blocked" and both notify. Same
        // invariant as the SUCCESS path — notify only when THIS call caused
        // the transition.
        //
        // The condition is on blockReason ALONE, deliberately. retryPayout
        // claims the row to PROCESSING before calling us, so on a retry the
        // row reads (PROCESSING, NO_BANK_DETAILS); also matching on status
        // would make every retry look like a fresh transition and re-notify
        // the operator each time. blockReason is untouched by the claim, so
        // it alone carries "has this operator already been told?".
        // The null branch is load-bearing, not defensive: blockReason is
        // nullable and a fresh payout starts NULL, so a bare
        // `NOT: { blockReason: NO_BANK_DETAILS }` compiles to
        // `NOT (blockReason = '...')`, which is UNKNOWN for NULL and matches
        // nothing. That would make the FIRST block of every payout look like
        // a repeat: no notification, and NO_BANK_DETAILS never written.
        const newlyBlocked = await this.prisma.payout.updateMany({
          where: {
            id: payoutId,
            OR: [
              { blockReason: null },
              { blockReason: { not: PayoutBlockReason.NO_BANK_DETAILS } },
            ],
          },
          data: {
            status: PayoutStatus.PENDING,
            blockReason: PayoutBlockReason.NO_BANK_DETAILS,
            failureReason: null,
          },
        });

        // The ledger's equivalent of the block above. Recorded regardless of
        // whether this call is the one that newly blocked it — that flag
        // governs re-notification, not the row's state.
        await this.blockPayment(
          rescueRequestId,
          operatorId,
          amount,
          PaymentBlockReason.NO_BANK_DETAILS,
        );

        if (newlyBlocked.count === 0) {
          // Already blocked for this reason — don't re-notify, but the row
          // still needs its status put back: a retry left it at PROCESSING,
          // and skipping the write entirely would strand it there.
          await this.prisma.payout.update({
            where: { id: payoutId },
            data: { status: PayoutStatus.PENDING, failureReason: null },
          });
          return;
        }

        // `operator` is null when the row is missing entirely (a data
        // integrity problem, not a missing-bank-details one) — the payout is
        // still correctly blocked above, there's just nobody to message.
        if (operator) {
          await this.notifyOperatorBankDetailsNeeded(
            operator,
            amount,
            rescueRequestId,
          );
        }
        return;
      }

      const balance = await this.paystackService.checkBalance();
      if (balance < amount) {
        await this.blockPayment(
          rescueRequestId,
          operatorId,
          amount,
          PaymentBlockReason.INSUFFICIENT_BALANCE,
        );
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: {
            status: 'PENDING',
            blockReason: 'INSUFFICIENT_BALANCE',
            failureReason: null,
          },
        });
        return;
      }

      // Claimed only now that we are actually going to transfer. Claiming
      // before the guards above would leave a SUBMITTED row behind whenever
      // checkBalance throws — and a submitted payout that never reached
      // Paystack is one verification can never settle, because a not-found
      // must never fail a payout.
      const payment = await this.claimPayoutPayment(
        rescueRequestId,
        operatorId,
        amount,
      );
      if (!payment) return;

      const result = await this.paystackService.initiateTransfer({
        recipientCode: operator.paystackRecipientCode,
        amount,
        reference: this.paymentLedger.referenceFor(payment),
        reason: `Job payout — ${rescueRequestId}`,
      });

      // Ambiguous first: a 5xx or a dropped connection may still have moved
      // money, so the row stays SUBMITTED and verification resolves it. The
      // legacy row goes to PROCESSING for the same reason.
      if (result.outcome === 'ambiguous') {
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: { status: 'PROCESSING', blockReason: null },
        });
        return;
      }

      if (result.outcome === 'rejected') {
        // Positive evidence the original landed — treat it as in flight, not
        // as a failure. See isDuplicateReference.
        if (isDuplicateReference(result)) {
          await this.prisma.payout.update({
            where: { id: payoutId },
            data: { status: 'PROCESSING', blockReason: null },
          });
          return;
        }
        const failureReason = result.message ?? 'transfer rejected';
        await this.paymentLedger.recordRejection(payment.id, failureReason);
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: { status: 'FAILED', blockReason: null, failureReason },
        });
        return;
      }

      // Recorded regardless — useful context, even though verification keys
      // on our own reference rather than this.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef: `trf:${result.data.transfer_code}` },
      });
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'PROCESSING',
          blockReason: null,
          paystackTransferCode: result.data.transfer_code,
        },
      });

      // A 2xx is not success. `otp` and `pending` are both possible, and even
      // a body saying `success` may NOT be claimed here — SUCCEEDED comes
      // only from a webhook or from verification. From this point the
      // response may move the row to BLOCKED or to a definitive failure, and
      // nowhere else.
      const mapped = mapTransferStatus(result.data.status);
      if (mapped.status === PaymentStatus.BLOCKED) {
        // The live bug's sibling: an `otp` transfer left SUBMITTED would be
        // polled forever, because nothing finishes it but a human.
        await this.paymentLedger.recordBlocked(payment.id, mapped.blockReason!);
      } else if (
        mapped.status === PaymentStatus.FAILED ||
        mapped.status === PaymentStatus.REVERSED
      ) {
        // `abandoned` lands here — the live bug. OTP was never answered, so
        // nothing moved and the transfer is dead.
        await this.paymentLedger.claimTerminal(payment.id, mapped);
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: {
            status: 'FAILED',
            failureReason: `Transfer ${result.data.status}`,
          },
        });
      }
      // Everything else — including `success` — stays SUBMITTED.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('❌ Payout attempt failed:', message);
      Sentry.captureException(err);
      await this.prisma.payout
        .update({
          where: { id: payoutId },
          data: { status: 'FAILED', blockReason: null, failureReason: message },
        })
        .catch((updateErr) => {
          console.error('❌ Failed to record payout failure:', updateErr);
          Sentry.captureException(updateErr);
        });
    }
  }

  /** Called from the Paystack webhook handler when a transfer's final outcome arrives. */
  async confirmTransferOutcome(
    transferCode: string,
    outcome: 'SUCCESS' | 'FAILED',
    failureReason?: string,
  ): Promise<void> {
    try {
      if (outcome === 'FAILED') {
        await this.prisma.payout.update({
          where: { paystackTransferCode: transferCode },
          data: {
            status: PayoutStatus.FAILED,
            failureReason: failureReason ?? 'Transfer failed',
          },
        });
        return;
      }

      // Conditional write so a re-delivered webhook (Paystack retries them)
      // can't send the operator a second "you've been paid" message. Note
      // this is at-most-once, not exactly-once: a crash between this write
      // and the send below means the notification is simply missed, since a
      // later redelivery matches 0 rows. Accepted for MVP — the operator was
      // paid, and the Payouts tab still shows it correctly.
      const changed = await this.prisma.payout.updateMany({
        where: {
          paystackTransferCode: transferCode,
          status: { not: PayoutStatus.SUCCESS },
        },
        data: { status: PayoutStatus.SUCCESS, completedAt: new Date() },
      });
      if (changed.count === 0) return;

      const payout = await this.prisma.payout.findUnique({
        where: { paystackTransferCode: transferCode },
        include: { operator: true },
      });
      if (payout?.operator) {
        await this.notifyOperatorPaid(
          payout.operator,
          payout.amount,
          payout.rescueRequestId,
        );
      }
    } catch (err) {
      console.error(
        `❌ No payout found for transfer code ${transferCode}:`,
        err,
      );
      Sentry.captureMessage(
        `Payout webhook: no payout found for transfer code ${transferCode}`,
        'warning',
      );
    }
  }

  // ══════════════════════════════════════════════════════
  //  OPERATOR NOTIFICATIONS
  // ══════════════════════════════════════════════════════
  //
  // Both are business-initiated and fire well outside any 24h WhatsApp
  // session the operator might have, so on a real number they MUST go
  // through an approved Content Template — a freeform body is rejected by
  // Meta (error 63016) outside the window. The freeform branch exists only
  // for local/sandbox use before the templates are approved.
  //
  // Neither may disrupt the payout flow: createAndProcessPayout is called
  // from handleBalancePaymentConfirmed and is documented as never throwing,
  // so every send is caught and reported rather than propagated. A failed
  // send leaves the payout row's status untouched and correct.

  private async notifyOperatorPaid(
    operator: { phoneNumber: string },
    amount: number,
    rescueRequestId: string,
  ): Promise<void> {
    const jobRef = formatJobRef(rescueRequestId).replace('Job #', '');
    // Pin the locale — an unpinned toLocaleString formats per the container's
    // default, so the same payout could render differently across environments.
    const naira = (amount / 100).toLocaleString('en-NG');
    const templateSid = process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID;

    try {
      if (templateSid) {
        await this.twilioService.sendWhatsAppTemplateMessage(
          toWhatsAppAddress(operator.phoneNumber),
          templateSid,
          { '1': jobRef, '2': naira },
        );
      } else {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(operator.phoneNumber),
          `💰 Payment sent — Job #${jobRef}. ₦${naira} has been transferred to your registered bank account.`,
        );
      }
    } catch (err) {
      console.error('❌ Failed to notify operator of payout:', err);
      Sentry.captureException(err, {
        extra: { rescueRequestId, notification: 'payout_sent' },
      });
    }
  }

  private async notifyOperatorBankDetailsNeeded(
    operator: { phoneNumber: string },
    amount: number,
    rescueRequestId: string,
  ): Promise<void> {
    const jobRef = formatJobRef(rescueRequestId).replace('Job #', '');
    // Pin the locale — an unpinned toLocaleString formats per the container's
    // default, so the same payout could render differently across environments.
    const naira = (amount / 100).toLocaleString('en-NG');
    const settingsUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:3001'}/settings`;
    const templateSid = process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID;

    try {
      if (templateSid) {
        await this.twilioService.sendWhatsAppTemplateMessage(
          toWhatsAppAddress(operator.phoneNumber),
          templateSid,
          { '1': jobRef, '2': naira, '3': settingsUrl },
        );
      } else {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(operator.phoneNumber),
          `💰 You've earned ₦${naira} for Job #${jobRef}. We don't have your bank details yet — add them at ${settingsUrl} to receive your payment.`,
        );
      }
    } catch (err) {
      console.error(
        '❌ Failed to notify operator of missing bank details:',
        err,
      );
      Sentry.captureException(err, {
        extra: { rescueRequestId, notification: 'payout_bank_details_needed' },
      });
    }
  }
}
