import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
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

  /** Re-run a blocked or failed payout from scratch — admin-triggered only. */
  async retryPayout(payoutId: string): Promise<void> {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) return;
    await this.attemptPayout(payoutId, payout.operatorId, payout.amount, payout.rescueRequestId);
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
