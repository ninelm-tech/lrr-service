import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PayoutStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
  ) {}

  /**
   * Create a Payout row for a completed job and attempt to process it
   * immediately. Never throws — every failure path is caught and reflected
   * in the Payout row's status/blockReason/failureReason instead, since
   * this is called from handleBalancePaymentConfirmed and must not disrupt
   * the customer/operator notification flow around it.
   */
  async createAndProcessPayout(rescueRequestId: string, operatorId: string, amount: number): Promise<void> {
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
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    const claimed = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: { in: [PayoutStatus.PENDING, PayoutStatus.FAILED] } },
      data: { status: PayoutStatus.PROCESSING },
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        `Only blocked or failed payouts can be retried — this one is ${payout.status}.`,
      );
    }

    await this.attemptPayout(payoutId, payout.operatorId, payout.amount, payout.rescueRequestId);
    return this.prisma.payout.findUnique({ where: { id: payoutId } });
  }

  /**
   * Never creates a Paystack recipient here — that only happens once,
   * synchronously, inside OperatorService.saveBankDetails (the one place
   * the full account number is ever available). This method only ever
   * consumes an already-existing paystackRecipientCode.
   */
  private async attemptPayout(payoutId: string, operatorId: string, amount: number, rescueRequestId: string): Promise<void> {
    try {
      const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
      if (!operator?.paystackRecipientCode) {
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: { status: 'PENDING', blockReason: 'NO_BANK_DETAILS', failureReason: null },
        });
        return;
      }

      const balance = await this.paystackService.checkBalance();
      if (balance < amount) {
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: { status: 'PENDING', blockReason: 'INSUFFICIENT_BALANCE', failureReason: null },
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
        data: { status: 'PROCESSING', blockReason: null, paystackTransferCode: transfer.transferCode },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('❌ Payout attempt failed:', message);
      Sentry.captureException(err);
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: { status: 'FAILED', blockReason: null, failureReason: message },
      }).catch((updateErr) => {
        console.error('❌ Failed to record payout failure:', updateErr);
        Sentry.captureException(updateErr);
      });
    }
  }

  /** Called from the Paystack webhook handler when a transfer's final outcome arrives. */
  async confirmTransferOutcome(transferCode: string, outcome: 'SUCCESS' | 'FAILED', failureReason?: string): Promise<void> {
    try {
      await this.prisma.payout.update({
        where: { paystackTransferCode: transferCode },
        data: outcome === 'SUCCESS'
          ? { status: 'SUCCESS', completedAt: new Date() }
          : { status: 'FAILED', failureReason: failureReason ?? 'Transfer failed' },
      });
    } catch (err) {
      console.error(`❌ No payout found for transfer code ${transferCode}:`, err);
      Sentry.captureMessage(`Payout webhook: no payout found for transfer code ${transferCode}`, 'warning');
    }
  }
}
