import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { toWhatsAppAddress } from '../common/phone.util';

@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  /**
   * Handles a customer's WhatsApp DISPUTE reply. Three explicit cases so
   * repeat messages can't corrupt state: first raise, no-op while already
   * open (prevents duplicate staff pings / disputeRaisedAt drift), and
   * reopen if the customer disputes again after resolution.
   */
  async raiseDispute(rescueRequestId: string, customerPhoneNumber: string) {
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
        ? { disputed: true, disputeRaisedAt: new Date(), disputeResolvedAt: null }
        : { disputed: true, disputeRaisedAt: new Date() },
    });

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(customerPhoneNumber),
      isReopen
        ? `⚠️ Your dispute has been reopened. Our team is on it.\n\nDo NOT release the vehicle until you hear from us.`
        : `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.\n\nDo NOT release the vehicle until you hear from us.`,
    );

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
      const jobRef = this.formatJobRef(rescueRequest.id); // "Job #A1B2C3"
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
   */
  async resolveDispute(rescueRequestId: string): Promise<{ resolved: boolean }> {
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

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { disputeResolvedAt: new Date() },
    });

    const jobRef = this.formatJobRef(rescueRequestId);
    const message = `The dispute on request ${jobRef} has been marked as resolved. Our team has completed the dispute review.`;

    try {
      if (rescueRequest.customer?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.customer.phoneNumber), message);
      }
    } catch (error) {
      console.error('Failed to notify customer of dispute resolution:', error);
    }

    try {
      if (rescueRequest.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber), message);
      }
    } catch (error) {
      console.error('Failed to notify operator of dispute resolution:', error);
    }

    return { resolved: true };
  }

  // Temporary local copy — removed once Task 4 extracts
  // domain/rescue-request-formatting.ts and this imports the shared one.
  private formatJobRef(rescueRequestId: string): string {
    return `Job #${rescueRequestId.slice(-6).toUpperCase()}`;
  }
}
