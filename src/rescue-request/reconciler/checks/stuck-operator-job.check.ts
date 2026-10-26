import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../../../platform-config/platform-config.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

const STUCK_STATUSES: RescueRequestStatus[] = [
  RescueRequestStatus.OPERATOR_ASSIGNED,
  RescueRequestStatus.ARRIVED,
];

/**
 * Alerts staff about a job that's gone quiet with a WhatsApp-enabled
 * operator assigned — the most likely cause is their WhatsApp account
 * having gone BSUID-masked mid-job (see the WhatsApp username/BSUID
 * identity design doc). Replaces an earlier, rejected design that tried to
 * catch this at the inbound router itself by blocking an unmatched BSUID
 * sender — indistinguishable there from a brand-new customer's first SOS.
 * This check instead has something concrete to alert on: an actual job
 * that's sat still too long, which staff can act on via the manual
 * override action (claimManualArrived/startManualCompletionConfirmation).
 */
@Injectable()
export class StuckOperatorJobCheck implements ReconcilerCheck {
  readonly name = 'stuck-operator-job';
  private readonly MAX_PER_PASS = 100;
  // Mirrors DepositExpiryCheck's 30-minute deposit window — the other
  // reconciler check built around "how long has this sat here."
  private readonly STALE_AFTER_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  async run(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() - this.STALE_AFTER_MS);
    const stale = await this.prisma.rescueRequest.findMany({
      where: {
        status: { in: STUCK_STATUSES },
        assignedOperator: { whatsappEnabled: true },
        updatedAt: { lt: threshold },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of stale) {
      if (await this.alert(id, now)) acted += 1;
    }
    return acted;
  }

  /**
   * Claims by touching `updatedAt` to `now` — there's no status change to
   * make here (the job is still legitimately assigned/arrived), so this is
   * what keeps a second pass from re-alerting on the same job, matching
   * the ReconcilerCheck contract that running a check twice is harmless.
   */
  private async alert(rescueRequestId: string, now: Date): Promise<boolean> {
    const threshold = new Date(now.getTime() - this.STALE_AFTER_MS);
    const { count } = await this.prisma.rescueRequest.updateMany({
      where: {
        id: rescueRequestId,
        status: { in: STUCK_STATUSES },
        assignedOperator: { whatsappEnabled: true },
        updatedAt: { lt: threshold },
      },
      data: { updatedAt: now },
    });
    if (count === 0) return false;

    const config = await this.platformConfigService.getConfig();
    const jobRef = formatJobRef(rescueRequestId);
    if (config.disputeAlertPhoneNumbers.length === 0) {
      // Claiming above already stops this job from being re-fetched every
      // tick, which is correct even with nothing configured to alert — but
      // that silence looks identical to "handled" unless flagged. This is
      // the one case where this check genuinely can't do its job: there is
      // no one to tell.
      Sentry.captureMessage(
        'StuckOperatorJobCheck: disputeAlertPhoneNumbers is empty — no staff alert was sent',
        { level: 'warning', extra: { rescueRequestId } },
      );
    }
    for (const phoneNumber of config.disputeAlertPhoneNumbers) {
      try {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(phoneNumber),
          `⚠️ ${jobRef} has had no activity in over 30 minutes with an operator still assigned — their WhatsApp account may have gone masked. Use the manual override action on the Requests tab to move it forward if needed.`,
        );
      } catch (error) {
        console.error('Stuck operator job staff alert failed:', error);
        Sentry.captureException(error, {
          extra: { rescueRequestId, stage: 'stuck-operator-job-alert' },
        });
      }
    }
    return true;
  }
}
