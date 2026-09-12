import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { scheduleSafely } from '../common/safe-timer';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import {
  DispatchOfferStatus,
  RescueRequestStatus,
  UserRole,
} from '@prisma/client';
import { formatJobRef } from './domain/rescue-request-formatting';

/**
 * Small shared helpers with no WhatsApp-flow state of their own, used by
 * two or more of the rescue-request services — kept here instead of on any
 * one of them so none has to depend on a sibling just to resolve a user or
 * format a location string.
 */
@Injectable()
export class RescueRequestSharedService {
  private readonly DEPOSIT_REMINDER_MARKS_MS = [5, 15, 25].map(
    (m) => m * 60 * 1000,
  );
  private readonly DEPOSIT_WINDOW_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocodingService: GeocodingService,
    private readonly twilioService: TwilioService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where: { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }

  /**
   * Operators were only ever given a raw Google Maps link for the pickup
   * point — no address, no area name, nothing readable without clicking
   * through. Reverse-geocodes so the message itself carries the full
   * picture (address if resolvable, map link always). Best-effort: a
   * failed/unconfigured geocode falls back to the map link alone rather
   * than blocking dispatch.
   */
  async formatLocationSection(lat: number, lon: number): Promise<string> {
    const address = await this.geocodingService.reverseGeocode(lat, lon);
    const mapLink = `https://maps.google.com/?q=${lat},${lon}`;
    return address ? `${address}\n📍 ${mapLink}` : mapLink;
  }

  /**
   * Ends any masked chat relay left open on a request that has just reached
   * a terminal state, telling both parties it's over.
   *
   * relayTarget is deliberately orthogonal to session state and is otherwise
   * only cleared by an explicit END CHAT. Since the relay branch runs ahead
   * of every other command in both flows, a job that ends mid-chat leaves
   * both parties permanently talking into a dead job: the operator can't
   * quote, send ARRIVED/DONE or rate, and the customer can't send SOS — or
   * even CANCEL, which the relay swallows too. Neither can get out
   * unprompted, so every path to a terminal status must call this.
   *
   * Best-effort by design: this is called from flows (payment confirmation,
   * cancellation) that must not fail because a courtesy message didn't send.
   */
  async endRelayForEndedRequest(rescueRequestId: string): Promise<void> {
    try {
      const request = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        include: { customer: true, assignedOperator: true },
      });
      if (!request) return;

      const phones: string[] = [];
      const userIds: string[] = [request.customerId];
      if (request.customer?.phoneNumber)
        phones.push(request.customer.phoneNumber);

      if (request.assignedOperator?.phoneNumber) {
        const operatorUser = await this.findOrCreateCustomer(
          request.assignedOperator.phoneNumber,
        );
        userIds.push(operatorUser.id);
        phones.push(request.assignedOperator.phoneNumber);
      }

      const cleared = await this.sessionStore.clearRelayTargets(userIds);
      if (cleared === 0) return; // no relay was open — don't message anyone

      await Promise.all(
        phones.map((phone) =>
          this.twilioService.sendWhatsAppMessage(
            phone,
            `Chat ended — this job is now closed.`,
          ),
        ),
      );
    } catch (error) {
      console.error('Failed to end chat relay for ended request:', error);
    }
  }

  /**
   * Gives a motorist 30 minutes to pay their deposit, with reminders at
   * 5/15/25 minutes, and cancels outright at 30 — no re-dispatch, since
   * nobody declined anything; the operator was simply waiting on payment.
   *
   * See docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
   * Section 1 for why the 30-minute cancel is an atomic claim (races the
   * payment-confirmation webhook) and why every reminder re-checks status
   * before sending.
   */
  scheduleDepositWindow(params: {
    rescueRequestId: string;
    customerId: string;
    customerPhone: string;
    operatorPhone: string;
    paymentUrl: string;
  }): void {
    const {
      rescueRequestId,
      customerId,
      customerPhone,
      operatorPhone,
      paymentUrl,
    } = params;

    for (const markMs of this.DEPOSIT_REMINDER_MARKS_MS) {
      const isFirstReminder = markMs === this.DEPOSIT_REMINDER_MARKS_MS[0];
      const isFinalWarning =
        markMs ===
        this.DEPOSIT_REMINDER_MARKS_MS[
          this.DEPOSIT_REMINDER_MARKS_MS.length - 1
        ];
      scheduleSafely(
        async () => {
          const fresh = await this.prisma.rescueRequest.findUnique({
            where: { id: rescueRequestId },
            select: { status: true },
          });
          if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return; // paid or cancelled already — no nag

          // Only the first reminder restates a concrete "time left" claim — the
          // customer was already told 5 minutes up front, so this is the one
          // reminder that lines up with what they were promised. Later
          // reminders (15/25 min marks) don't repeat a number, since the real
          // window keeps running to 30 and any fixed figure at that point
          // would just be wrong.
          const timeNote = isFirstReminder
            ? '\n\nYou have 5 more minutes to complete payment.'
            : '';
          const warning = isFinalWarning
            ? "\n\n⚠️ Your request will be cancelled soon if we don't receive payment."
            : '';
          await this.twilioService.sendWhatsAppMessage(
            customerPhone,
            `⏰ Reminder — tap the link below to pay and confirm your rescue:\n\n👉 ${paymentUrl}${timeNote}${warning}`,
          );
        },
        markMs,
        `deposit-reminder-${markMs}ms`,
      );
    }

    scheduleSafely(
      async () => {
        const claimed = await this.prisma.rescueRequest.updateMany({
          where: {
            id: rescueRequestId,
            status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
          },
          data: { status: RescueRequestStatus.CANCELLED },
        });
        if (claimed.count === 0) return; // the payment webhook won the race — nothing to do

        // The customer's session was set to OPERATOR_FOUND_WAITING_PAYMENT when
        // the deposit flow started. Reset it now so a follow-up WhatsApp
        // message doesn't hit stale state and get told to pay a request that
        // was just cancelled.
        await this.sessionStore.update(customerId, {
          state: WhatsAppFlowState.IDLE,
          rescueRequestId: undefined,
        });

        await this.prisma.dispatchOffer.updateMany({
          where: {
            rescueRequestId,
            status: DispatchOfferStatus.SELECTED_PENDING_PAYMENT,
          },
          data: {
            status: DispatchOfferStatus.TIMED_OUT,
            respondedAt: new Date(),
          },
        });
        // CHAT DRIVER is available from quote selection onward, so a relay can
        // well be open on a request that dies waiting for the deposit.
        await this.endRelayForEndedRequest(rescueRequestId);
        await this.twilioService.sendWhatsAppMessage(
          customerPhone,
          `We didn't receive payment confirmation within 30 minutes, so your request was cancelled. If your payment completes after this, we'll refund it.`,
        );
        await this.twilioService.sendWhatsAppMessage(
          operatorPhone,
          `⏰ ${formatJobRef(rescueRequestId)} is no longer available — the customer didn't pay in time.`,
        );
      },
      this.DEPOSIT_WINDOW_MS,
      'deposit-window-expiry',
    );
  }
}
