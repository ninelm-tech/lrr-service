import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { ReconcilerCheck } from '../reconciler-check.interface';

/** Minutes remaining at which a reminder is due. Descending: index 0 is the earliest nudge. */
const REMINDER_MARKS_MINUTES_LEFT = [25, 15, 5];

@Injectable()
export class DepositReminderCheck implements ReconcilerCheck {
  readonly name = 'deposit-reminder';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    // Every condition is in the predicate, so all 100 rows fetched are rows
    // that genuinely need a reminder.
    //
    // Filtering dueness in JavaScript would be a real defect, not a style
    // preference: non-due requests would fill the page and starve requests
    // that actually need nudging, silently and only under load.
    //
    // `depositWindowExpiresAt > now` matters too — an expired window must
    // produce no nudge at all, or a motorist receives "you have 5 minutes
    // left" seconds before "your request was cancelled".
    //
    // The OR expresses "the next unsent mark has been reached": with none
    // sent, that is the 25-minute mark; with one sent, the 15-minute mark;
    // and so on.
    const candidates = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: { gt: now },
        OR: REMINDER_MARKS_MINUTES_LEFT.map((mark, index) => ({
          depositRemindersSent: index,
          depositWindowExpiresAt: {
            lte: new Date(now.getTime() + mark * 60_000),
          },
        })),
      },
      select: {
        id: true,
        depositWindowExpiresAt: true,
        depositPaymentUrl: true,
        customer: { select: { phoneNumber: true } },
      },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const request of candidates) {
      const dueCount = this.dueCount(request.depositWindowExpiresAt!, now);
      const sent = await this.send(
        request.id,
        dueCount,
        request.customer?.phoneNumber ?? null,
        request.depositPaymentUrl,
        request.depositWindowExpiresAt!,
        now,
      );
      if (sent) acted += 1;
    }
    return acted;
  }

  /** How many marks have been reached. Marks are minutes-remaining thresholds, so fewer minutes left means more are due. */
  private dueCount(expiresAt: Date, now: Date): number {
    const minutesLeft = (expiresAt.getTime() - now.getTime()) / 60_000;
    return REMINDER_MARKS_MINUTES_LEFT.filter((mark) => minutesLeft <= mark)
      .length;
  }

  /**
   * Sets the counter TO dueCount rather than incrementing it. Fast-forward
   * after downtime is then inherent — skipped marks can never come due
   * again — and a second instance finds the counter already at dueCount and
   * matches nothing.
   */
  private async send(
    rescueRequestId: string,
    dueCount: number,
    phoneNumber: string | null,
    paymentUrl: string | null,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    // `depositWindowExpiresAt: expiresAt` binds the claim to the exact
    // deadline dueCount was computed from. Without it, a deposit window
    // reset between the read and the claim would be fast-forwarded using
    // the old deadline — skipping reminders the new window is owed.
    const { count } = await this.prisma.rescueRequest.updateMany({
      where: {
        id: rescueRequestId,
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: expiresAt,
        depositRemindersSent: { lt: dueCount },
      },
      data: { depositRemindersSent: dueCount },
    });
    if (count === 0) return false;
    if (!phoneNumber) return true;

    const minutesLeft = Math.max(
      1,
      Math.round((expiresAt.getTime() - now.getTime()) / 60_000),
    );
    // A reminder without the link asks the motorist to scroll back through
    // the thread to act, so send it whenever we have it. Older requests
    // predate the column and simply get the plainer nudge.
    const link = paymentUrl ? `\n\n👉 ${paymentUrl}` : '';
    try {
      await this.twilioService.sendWhatsAppMessage(
        phoneNumber,
        `⏰ Reminder — your rescue request is still waiting for payment.${link}\n\nYou have about ${minutesLeft} minutes left before it is cancelled.`,
      );
    } catch (error) {
      console.error('Deposit reminder failed:', error);
      Sentry.captureException(error, {
        extra: { rescueRequestId, stage: 'deposit-reminder-notify' },
      });
    }
    return true;
  }
}
