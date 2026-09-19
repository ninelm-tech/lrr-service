import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { DispatchOfferStatus, RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Cancels a request whose 30-minute deposit window has run out.
 *
 * Replaces the `deposit-window-expiry` timer, which died with the process
 * that armed it — leaving the motorist mid-flow and the operator holding a
 * job nobody would ever pay for.
 */
@Injectable()
export class DepositExpiryCheck implements ReconcilerCheck {
  readonly name = 'deposit-expiry';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: { lt: now },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.expire(id, now)) acted += 1;
    }
    return acted;
  }

  /**
   * Claim and every write that must be consistent with it commit together.
   * Cancelling without releasing the held offer would leave a request no
   * check can ever match again: the claim below requires
   * WAITING_FOR_DEPOSIT, which the cancel itself removes.
   *
   * The session writes are in here for the same reason rather than because
   * they are urgent. A motorist left in OPERATOR_FOUND_WAITING_PAYMENT is
   * told to pay for a job that no longer exists, and a relay left open locks
   * both parties out of every later job — neither has any other repair path,
   * so neither may be separable from the cancel.
   */
  private async expire(rescueRequestId: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      // The deadline belongs in the claim, not only in the query above: if
      // it were extended between the two (an admin granting more time), a
      // claim on status alone would still cancel.
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
          depositWindowExpiresAt: { lt: now },
        },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      if (count === 0) return null;

      await tx.dispatchOffer.updateMany({
        where: {
          rescueRequestId,
          status: DispatchOfferStatus.SELECTED_PENDING_PAYMENT,
        },
        data: { status: DispatchOfferStatus.TIMED_OUT, respondedAt: now },
      });

      // Both parties' sessions carry this request's id while a relay is open
      // (whatsapp-customer-flow sets it on the operator's session when the
      // relay starts), so one scalar filter reaches both sides without
      // resolving the operator's User — which would be a write of its own.
      await tx.whatsAppSession.updateMany({
        where: { rescueRequestId, relayTarget: { not: null } },
        data: { relayTarget: null },
      });

      // The motorist was moved to OPERATOR_FOUND_WAITING_PAYMENT when the
      // deposit flow began. Reset it so a follow-up message doesn't get told
      // to pay for a request that was just cancelled.
      await tx.whatsAppSession.updateMany({
        where: { rescueRequestId },
        data: { state: 'IDLE', rescueRequestId: null },
      });

      return tx.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        include: { customer: true, assignedOperator: true },
      });
    });

    if (!claimed) return false;

    // Notifications only after the transaction commits: best-effort, never
    // retried. No separate "chat ended" notice — the two messages below say
    // the job is over, and a duplicate costs a billable WhatsApp send.
    const jobRef = formatJobRef(rescueRequestId);
    try {
      if (claimed.customer?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(
          claimed.customer.phoneNumber,
          `We didn't receive payment confirmation within 30 minutes, so your request was cancelled. If your payment completes after this, we'll refund it.`,
        );
      }
      if (claimed.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(claimed.assignedOperator.phoneNumber),
          `⏰ ${jobRef} is no longer available — the customer didn't pay in time.`,
        );
      }
    } catch (error) {
      console.error('Deposit expiry notification failed:', error);
      Sentry.captureException(error, {
        extra: { rescueRequestId, stage: 'deposit-expiry-notify' },
      });
    }

    return true;
  }
}
