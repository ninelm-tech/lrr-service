import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Cancels a request whose motorist was sent a shortlist and never chose.
 *
 * The deadline is stamped by whichever check progressed the request past
 * bidding, in the same transaction as that progression — so a request can
 * never arrive here without one.
 */
@Injectable()
export class QuoteSelectionTimeoutCheck implements ReconcilerCheck {
  readonly name = 'quote-selection-timeout';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.DISPATCHING,
        quoteSelectionExpiresAt: { lt: now },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.timeOut(id, now)) acted += 1;
    }
    return acted;
  }

  private async timeOut(rescueRequestId: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteSelectionExpiresAt: { lt: now },
        },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      if (count === 0) return null;

      const quoting = await tx.dispatchOffer.findMany({
        where: { rescueRequestId, status: 'QUOTED' },
        include: { operator: { select: { phoneNumber: true } } },
      });
      await tx.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'QUOTED' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: {
          customerId: true,
          customer: { select: { phoneNumber: true } },
        },
      });

      // The timer this replaces cleared the session as well. Left at
      // WAITING_FOR_QUOTE_SELECTION, the motorist's next message is read as
      // a choice between quotes on a request that no longer exists — and
      // nothing else would ever repair it, so it belongs in the claim.
      await tx.whatsAppSession.updateMany({
        where: { userId: request.customerId },
        data: { state: 'IDLE', rescueRequestId: null },
      });

      return {
        operatorPhones: quoting.map((o) => o.operator.phoneNumber),
        customerPhone: request.customer?.phoneNumber ?? null,
      };
    });

    if (!claimed) return false;

    try {
      if (claimed.customerPhone) {
        await this.twilioService.sendWhatsAppMessage(
          claimed.customerPhone,
          `⏰ You didn't choose a quote in time. Your request has been cancelled — send SOS to start again.`,
        );
      }
      await Promise.all(
        claimed.operatorPhones.map((phone) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(phone!),
            `⏰ ${formatJobRef(rescueRequestId)} is no longer available — the customer didn't choose a quote in time. Watch for new offers!`,
          ),
        ),
      );
    } catch (error) {
      console.error('Quote-selection timeout notification failed:', error);
      Sentry.captureException(error, {
        extra: { rescueRequestId, stage: 'quote-selection-notify' },
      });
    }
    return true;
  }
}
