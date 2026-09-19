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
  PaymentType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { mapTransferStatus } from '../payment/domain/paystack-status';
import { isDuplicateReference } from '../payment/domain/duplicate-reference';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from '../rescue-request/domain/rescue-request-formatting';

/** The states retryPayout may act on — the money movement never landed. */
const RETRYABLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.FAILED,
  PaymentStatus.BLOCKED,
];

/**
 * Payouts, on the Payment ledger.
 *
 * Payment becomes the only record of money movement here (Task 11 — the
 * dedicated Payout table this dual-wrote to is gone). One row is one
 * attempt: a retry of a FAILED payout inserts a sibling row rather than
 * mutating the old one, exactly like deposits, balances, and refunds — the
 * failed row stays as history.
 */
@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly paymentLedger: PaymentLedgerService,
  ) {}

  /**
   * Attempt a payout for a completed job. Never throws — every failure path
   * is caught and reflected in the Payment row instead, since this is
   * called from confirmBalance/resolveDispute's settlement flow and must not
   * disrupt the customer/operator notification flow around it.
   */
  async createAndProcessPayout(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
  ): Promise<void> {
    await this.attemptPayout(rescueRequestId, operatorId, amount);
  }

  /**
   * Re-run a blocked or failed payout attempt — admin-triggered only.
   *
   * Only those two states may be retried. A SUCCEEDED payout is done; a
   * SUBMITTED one is already in flight — retrying either would risk a
   * second real Paystack transfer. This check is a courtesy for the error
   * message, not the safety guarantee: the real protection is
   * claimPayoutPayment's own atomic claim (via the in-flight partial unique
   * index), which two admins double-clicking Retry would both hit — only
   * one wins, the other's call is a safe no-op.
   *
   * The row passed in is one ATTEMPT, not the whole payout — a job can have
   * an old FAILED row sitting in the list right alongside a newer SUCCEEDED
   * sibling, from a normal retry that inserted a fresh attempt which later
   * succeeded. That older row's own status says nothing about whether the
   * job has already been paid, so this checks the real final state — does
   * ANY row for this request+type already say SUCCEEDED —
   * before touching Paystack at all.
   *
   * Returns the LATEST attempt for this request after retrying — not
   * necessarily the same row passed in, since a retry of a FAILED payout
   * creates a fresh sibling rather than reusing it. Reporting the original
   * row's stale state would tell an admin the opposite of what happened.
   */
  async retryPayout(paymentId: string): Promise<Payment | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.type !== PaymentType.PAYOUT) {
      throw new NotFoundException('Payout not found');
    }
    if (!RETRYABLE_STATUSES.includes(payment.status)) {
      throw new BadRequestException(
        `Only blocked or failed payouts can be retried — this one is ${payment.status}.`,
      );
    }
    if (!payment.operatorId) {
      // PAYOUT rows always carry operatorId (set at creation) — a type-safe
      // guard rather than a trusted assumption.
      throw new BadRequestException('Payout has no operator on record.');
    }
    const succeeded = await this.findSucceededPayout(payment.rescueRequestId);
    if (succeeded) {
      throw new BadRequestException(
        `This payout already succeeded (payment ${succeeded.id}) — retrying would risk paying the operator twice.`,
      );
    }

    await this.attemptPayout(
      payment.rescueRequestId,
      payment.operatorId,
      payment.amount,
    );
    return this.prisma.payment.findFirst({
      where: { rescueRequestId: payment.rescueRequestId, type: 'PAYOUT' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Any row for this request+type that already says SUCCEEDED, if one exists. */
  private async findSucceededPayout(
    rescueRequestId: string,
  ): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: {
        rescueRequestId,
        type: PaymentType.PAYOUT,
        status: PaymentStatus.SUCCEEDED,
      },
    });
  }

  /**
   * The ledger row for this attempt, claimed and ready to submit.
   *
   * A retry reuses whatever its previous attempt left in flight rather than
   * inserting a sibling: the in-flight partial unique index permits only
   * one. A BLOCKED row always resubmits with the SAME reference, regardless
   * of why it was blocked — Paystack rejects a reused reference as a
   * duplicate rather than moving money twice (see isDuplicateReference),
   * and the in-flight index already guarantees only one row can be live at
   * a time, so reusing the reference is the safe choice, not the risky one.
   *
   * SUCCEEDED is folded into the same lookup as the in-flight statuses, not
   * because a succeeded row is in flight, but so this is the ONE place that
   * decides whether a fresh attempt may ever start — retryPayout pre-checks
   * this too, for a clearer error message, but this is the real guard: it
   * also covers createAndProcessPayout's automatic path, which has no
   * caller-side check at all.
   *
   * Returns null only when this attempt must not proceed — the payout has
   * already succeeded, the row is still SUBMITTED (already at Paystack, no
   * reply yet), or another caller won the claim. **A null means do not call
   * Paystack.**
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
            PaymentStatus.SUCCEEDED,
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

    if (existing.status === PaymentStatus.BLOCKED) {
      return (await this.paymentLedger.unblock(existing.id, new Date()))
        ? existing
        : null;
    }

    return null;
  }

  /**
   * Record a block we caused ourselves, on a row that never reached
   * Paystack. Returns whether this is the FIRST time this reason was
   * recorded on the current attempt, so the caller knows whether to
   * (re-)notify — a repeat block for the SAME reason on a later call (e.g.
   * an admin re-triggering before fixing the underlying cause) must not
   * spam the operator every time.
   *
   * The "before" read and the claim below are not atomic together — a
   * genuine race here could double-notify or (rarely) miss a notification.
   * Accepted: this path is admin-paced, not hot, and the risk is a UX
   * nicety, never a money-safety one (see notifyOperatorPaid's own
   * at-most-once trade-off for the same reasoning).
   *
   * Silently does nothing (and returns false) if a real transfer is in
   * flight for this request — overwriting a SUBMITTED row with a block
   * would lose track of money that is actually moving.
   */
  private async blockPayment(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
    reason: PaymentBlockReason,
  ): Promise<boolean> {
    const before = await this.prisma.payment.findFirst({
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
    const isRepeat = before?.blockReason === reason;

    const payment = await this.claimPayoutPayment(
      rescueRequestId,
      operatorId,
      amount,
    );
    if (!payment) return false;
    await this.paymentLedger.recordBlocked(payment.id, reason);
    return !isRepeat;
  }

  /**
   * Never creates a Paystack recipient here — that only happens once,
   * synchronously, inside OperatorService.saveBankDetails (the one place
   * the full account number is ever available). This method only ever
   * consumes an already-existing paystackRecipientCode.
   */
  private async attemptPayout(
    rescueRequestId: string,
    operatorId: string,
    amount: number,
  ): Promise<void> {
    try {
      const operator = await this.prisma.operator.findUnique({
        where: { id: operatorId },
      });
      if (!operator?.paystackRecipientCode) {
        const isNewBlock = await this.blockPayment(
          rescueRequestId,
          operatorId,
          amount,
          PaymentBlockReason.NO_BANK_DETAILS,
        );
        // `operator` is null when the row is missing entirely (a data
        // integrity problem, not a missing-bank-details one) — the payout
        // is still correctly blocked above, there's just nobody to message.
        if (isNewBlock && operator?.phoneNumber) {
          await this.notifyOperatorBankDetailsNeeded(
            { ...operator, phoneNumber: operator.phoneNumber },
            amount,
            rescueRequestId,
          );
        }
        return;
      }

      const balance = await this.paystackService.checkBalance();
      if (balance < amount) {
        // No notification for this reason — matches the pre-Task-11
        // behaviour, which never messaged the operator about platform
        // balance; that is staff's problem, not theirs.
        await this.blockPayment(
          rescueRequestId,
          operatorId,
          amount,
          PaymentBlockReason.INSUFFICIENT_BALANCE,
        );
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

      await this.applyTransferResult(payment.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('❌ Payout attempt failed:', message);
      Sentry.captureException(err);
      // Best-effort: the payment row may not exist yet, or may already have
      // moved past a state this can touch. Either way this is a diagnostic
      // aid, not the source of truth for what happened.
      await this.prisma.payment
        .updateMany({
          where: {
            rescueRequestId,
            type: 'PAYOUT',
            status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED] },
          },
          data: { failureReason: message },
        })
        .catch((updateErr: unknown) => {
          console.error('❌ Failed to record payout failure:', updateErr);
          Sentry.captureException(updateErr);
        });
    }
  }

  /**
   * Classifies a transfer response and applies it to the ledger. Shared by
   * this service's own submission and PaymentVerifyCheck's not-found
   * re-submission — both call initiateTransfer and must land on the row the
   * same way.
   */
  private async applyTransferResult(
    paymentId: string,
    result: {
      outcome: 'ok' | 'rejected' | 'ambiguous';
      data?: { status: string; transfer_code: string };
      code?: string;
      message?: string;
    },
  ): Promise<void> {
    // Ambiguous first: a 5xx or a dropped connection may still have moved
    // money, so the row stays SUBMITTED and verification resolves it.
    if (result.outcome === 'ambiguous') return;

    if (result.outcome === 'rejected') {
      // Positive evidence the original landed — treat it as in flight, not
      // as a failure. See isDuplicateReference.
      if (isDuplicateReference(result)) return;
      await this.paymentLedger.recordRejection(
        paymentId,
        result.message ?? 'transfer rejected',
      );
      return;
    }

    // Recorded regardless — useful context, even though verification keys
    // on our own reference rather than this.
    await this.prisma.payment
      .update({
        where: { id: paymentId },
        data: { providerRef: `trf:${result.data!.transfer_code}` },
      })
      .catch(() => undefined);

    // A 2xx is not success. `otp` and `pending` are both possible, and even
    // a body saying `success` may NOT be claimed here — SUCCEEDED comes
    // only from a webhook or from verification, which is also where the
    // operator's "you've been paid" notification fires (notifyPayoutOutcome).
    const mapped = mapTransferStatus(result.data!.status);
    if (mapped.status === PaymentStatus.BLOCKED) {
      // The live bug's sibling: an `otp` transfer left SUBMITTED would be
      // polled forever, because nothing finishes it but a human.
      await this.paymentLedger.recordBlocked(paymentId, mapped.blockReason!);
    } else if (
      mapped.status === PaymentStatus.FAILED ||
      mapped.status === PaymentStatus.REVERSED
    ) {
      // `abandoned` lands here — the live bug. OTP was never answered, so
      // nothing moved and the transfer is dead.
      await this.paymentLedger.claimTerminal(paymentId, mapped);
    }
    // Everything else — including `success` — stays SUBMITTED.
  }

  /**
   * Called once, by whichever caller — the webhook or PaymentVerifyCheck —
   * actually won the claim settling a PAYOUT payment to SUCCEEDED. This is
   * the ONLY place that notifies the operator they've been paid.
   */
  async notifyPayoutOutcome(payment: Payment): Promise<void> {
    if (payment.status !== PaymentStatus.SUCCEEDED || !payment.operatorId) {
      return;
    }
    const operator = await this.prisma.operator.findUnique({
      where: { id: payment.operatorId },
    });
    if (operator?.phoneNumber) {
      await this.notifyOperatorPaid(
        { ...operator, phoneNumber: operator.phoneNumber },
        payment.amount,
        payment.rescueRequestId,
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
  // from confirmBalance's settlement flow and is documented as never
  // throwing, so every send is caught and reported rather than propagated.
  // A failed send leaves the Payment row's status untouched and correct.

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
