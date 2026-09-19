import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../../../platform-config/platform-config.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Tells staff when an operator marked a job done and the customer has gone
 * quiet. Alerts only — the job is never auto-completed, because silence and
 * avoidance look identical from here.
 */
@Injectable()
export class StalledConfirmationCheck implements ReconcilerCheck {
  readonly name = 'stalled-confirmation';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        confirmationDueAt: { lt: now },
        disputed: false,
        status: {
          notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED],
        },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      // Clearing the due date is the claim: it removes the row from this
      // match, so a second tick — or a second instance — finds nothing.
      const { count } = await this.prisma.rescueRequest.updateMany({
        where: {
          id,
          confirmationDueAt: { lt: now },
          disputed: false,
          status: {
            notIn: [
              RescueRequestStatus.COMPLETED,
              RescueRequestStatus.CANCELLED,
            ],
          },
        },
        data: { confirmationDueAt: null },
      });
      if (count === 0) continue;

      try {
        const config = await this.platformConfigService.getConfig();
        if (config.disputeAlertPhoneNumber) {
          await this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(config.disputeAlertPhoneNumber),
            `⏱ ${formatJobRef(id)}: customer hasn't confirmed completion 30 minutes after the operator marked it DONE. Please check on them.`,
          );
        }
      } catch (error) {
        console.error('Stalled-confirmation alert failed:', error);
        Sentry.captureException(error, {
          extra: { rescueRequestId: id, stage: 'stalled-confirmation-notify' },
        });
      }
      acted += 1;
    }
    return acted;
  }
}
