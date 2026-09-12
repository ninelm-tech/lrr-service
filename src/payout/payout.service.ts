import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PayoutStatus, PayoutBlockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from '../rescue-request/domain/rescue-request-formatting';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
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
   * Never creates a Paystack recipient here — that only happens once,
   * synchronously, inside OperatorService.saveBankDetails (the one place
   * the full account number is ever available). This method only ever
   * consumes an already-existing paystackRecipientCode.
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

      const reference = this.paystackService.generateReference('PAYOUT');
      const transfer = await this.paystackService.initiateTransfer({
        recipientCode: operator.paystackRecipientCode,
        amount,
        reference,
        reason: `Job payout — ${rescueRequestId}`,
      });

      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'PROCESSING',
          blockReason: null,
          paystackTransferCode: transfer.transferCode,
        },
      });
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
