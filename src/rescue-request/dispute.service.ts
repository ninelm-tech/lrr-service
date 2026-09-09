import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentEventsService } from './payment-events.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from './domain/rescue-request-formatting';

@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly sharedService: RescueRequestSharedService,
    // WhatsAppCustomerFlowService → DisputeService → PaymentEventsService →
    // WhatsAppCustomerFlowService is a 3-hop cycle (the last edge already
    // forwardRef'd on both sides) — this edge needs it too, or Nest can't
    // resolve DisputeService's own dependencies.
    @Inject(forwardRef(() => PaymentEventsService))
    private readonly paymentEventsService: PaymentEventsService,
  ) {}

  /**
   * Handles a customer's WhatsApp DISPUTE reply. Three explicit cases so
   * repeat messages can't corrupt state: first raise, no-op while already
   * open (prevents duplicate staff pings / disputeRaisedAt drift), and
   * reopen if the customer disputes again after resolution.
   *
   * customerUserId is optional so existing callers that don't have it handy
   * still compile; it's required in practice to put the customer's own
   * session into AWAITING_DISPUTE_REASON — without it we can still raise
   * the dispute, we just can't prompt that customer for their statement.
   */
  async raiseDispute(rescueRequestId: string, customerPhoneNumber: string, customerUserId?: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) return;

    if (rescueRequest.disputed && !rescueRequest.disputeResolvedAt) {
      // Already open — no DB write, no re-alert.
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(customerPhoneNumber),
        `This request is already flagged as disputed — our team is on it.`,
      );
      return;
    }

    const isReopen = rescueRequest.disputed && !!rescueRequest.disputeResolvedAt;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: isReopen
        ? { disputed: true, disputeRaisedAt: new Date(), disputeResolvedAt: null, status: RescueRequestStatus.IN_DISPUTE }
        : { disputed: true, disputeRaisedAt: new Date(), status: RescueRequestStatus.IN_DISPUTE },
    });

    const config = await this.platformConfigService.getConfig();
    const callLine = config.disputeAlertPhoneNumber
      ? ` Or call us directly: ${config.disputeAlertPhoneNumber}.`
      : '';

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(customerPhoneNumber),
      (isReopen
        ? `⚠️ Your dispute has been reopened. Our team is on it and will contact you shortly.`
        : `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.`)
        + `\n\nPlease reply with what happened, so we have your side of the story.${callLine}`,
    );

    if (customerUserId) {
      await this.sessionStore.update(customerUserId, {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId,
      });
    }

    // The operator is the one physically holding the vehicle — they're the
    // one who needs to hear "don't release it," not the customer. Best-effort:
    // a failed operator notification shouldn't block the dispute itself.
    if (rescueRequest.assignedOperator?.phoneNumber) {
      try {
        const opUser = await this.sharedService.findOrCreateCustomer(rescueRequest.assignedOperator.phoneNumber);
        await this.sessionStore.update(opUser.id, {
          state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
          rescueRequestId,
        });
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber),
          (isReopen
            ? `⚠️ The customer's dispute on ${formatJobRef(rescueRequestId)} has been reopened.`
            : `⚠️ The customer has disputed ${formatJobRef(rescueRequestId)}. Our team will review shortly.`)
            + `\n\nDo NOT release the vehicle until you hear from us.`
            + `\n\nPlease reply with your side of what happened.${callLine}`,
        );
      } catch (error) {
        console.error('Failed to notify operator of raised dispute:', error);
      }
    }

    await this.sendStaffDisputeAlert(rescueRequest);
  }

  /**
   * Best-effort — a failed staff alert never blocks the customer-facing
   * flow. This is always a business-initiated message (staff never texts
   * first), so on a real (non-sandbox) number it MUST go through the
   * approved `dispute_raised_alert` Content Template — a freeform body
   * gets rejected by Meta outside a session window. Falls back to a
   * freeform send only when TWILIO_DISPUTE_TEMPLATE_SID isn't configured
   * (e.g. local/sandbox testing before the template exists).
   */
  private async sendStaffDisputeAlert(rescueRequest: any) {
    try {
      const config = await this.platformConfigService.getConfig();
      if (!config.disputeAlertPhoneNumber) return;

      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
      const jobRef = formatJobRef(rescueRequest.id); // "Job #A1B2C3"
      const dashboardLink = `${frontendUrl}/requests?highlight=${rescueRequest.id}`;
      const templateSid = process.env.TWILIO_DISPUTE_TEMPLATE_SID;

      if (templateSid) {
        // Template body is "...Job {{1}}. Log in to review: {{2}} now." —
        // {{1}} needs the bare ref, "Job " is already static text in the
        // approved template itself.
        await this.twilioService.sendWhatsAppTemplateMessage(
          toWhatsAppAddress(config.disputeAlertPhoneNumber),
          templateSid,
          { '1': jobRef.replace('Job #', ''), '2': dashboardLink },
        );
      } else {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(config.disputeAlertPhoneNumber),
          `🚨 New dispute raised — ${jobRef}\n\nLog in to view: ${dashboardLink}`,
        );
      }
    } catch (error) {
      console.error('Failed to send dispute staff alert:', error);
    }
  }

  /**
   * Marks a disputed request resolved. Idempotent: never-disputed is
   * rejected, already-resolved returns successfully with no side effects
   * (safe to retry), and the real case notifies both parties best-effort.
   *
   * resolutionNote is staff's record of what happened/was decided.
   * balanceAdjustmentPercent (1-100, default 100 = no change) settles what
   * the customer actually owes. Status is deliberately left at IN_DISPUTE —
   * it only becomes COMPLETED once the settled amount is actually paid
   * (handleBalancePaymentConfirmed), same trigger every job already uses.
   * This snapshots the pre-adjustment balance onto
   * disputeOriginalBalanceAmount before overwriting balanceAmount with the
   * settled figure, so "quoted vs. actually charged" is never lost.
   */
  async resolveDispute(
    rescueRequestId: string,
    resolutionNote: string,
    balanceAdjustmentPercent = 100,
  ): Promise<{ resolved: boolean }> {
    if (!Number.isInteger(balanceAdjustmentPercent) || balanceAdjustmentPercent < 1 || balanceAdjustmentPercent > 100) {
      throw new BadRequestException('balanceAdjustmentPercent must be an integer between 1 and 100.');
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) throw new NotFoundException('Rescue request not found');

    if (!rescueRequest.disputed) {
      throw new BadRequestException('This request has never been disputed.');
    }

    if (rescueRequest.disputeResolvedAt) {
      // Already resolved — safe to call again, no-op.
      return { resolved: true };
    }

    const originalBalance = rescueRequest.balanceAmount ?? 0;
    const settledBalance = Math.round(originalBalance * balanceAdjustmentPercent / 100);

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: {
        disputeResolvedAt: new Date(),
        disputeResolutionNote: resolutionNote,
        disputeOriginalBalanceAmount: originalBalance,
        balanceAmount: settledBalance,
      },
    });

    // Send the settlement payment link directly — resolving a dispute
    // replaces the customer's CONFIRM, it doesn't ask them to CONFIRM again.
    await this.paymentEventsService.sendBalancePaymentLink({ ...rescueRequest, balanceAmount: settledBalance });

    const jobRef = formatJobRef(rescueRequestId);
    const operatorMessage = `The dispute on ${jobRef} has been resolved. A payment link for ₦${(settledBalance / 100).toLocaleString()} has been sent to the customer.`;

    try {
      if (rescueRequest.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber), operatorMessage);
      }
    } catch (error) {
      console.error('Failed to notify operator of dispute resolution:', error);
    }

    return { resolved: true };
  }
}
