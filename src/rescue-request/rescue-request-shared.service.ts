import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { DispatchOfferStatus, RescueRequestStatus, UserRole } from '@prisma/client';

/**
 * Small shared helpers with no WhatsApp-flow state of their own, used by
 * two or more of the rescue-request services — kept here instead of on any
 * one of them so none has to depend on a sibling just to resolve a user or
 * format a location string.
 */
@Injectable()
export class RescueRequestSharedService {
  private readonly DEPOSIT_REMINDER_MARKS_MS = [5, 15, 25].map((m) => m * 60 * 1000);
  private readonly DEPOSIT_WINDOW_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocodingService: GeocodingService,
    private readonly twilioService: TwilioService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where:  { phoneNumber },
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
    const { rescueRequestId, customerId, customerPhone, operatorPhone, paymentUrl } = params;

    for (const markMs of this.DEPOSIT_REMINDER_MARKS_MS) {
      const isFinalWarning = markMs === this.DEPOSIT_REMINDER_MARKS_MS[this.DEPOSIT_REMINDER_MARKS_MS.length - 1];
      setTimeout(async () => {
        const fresh = await this.prisma.rescueRequest.findUnique({
          where: { id: rescueRequestId },
          select: { status: true },
        });
        if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return; // paid or cancelled already — no nag

        const warning = isFinalWarning ? '\n\n⚠️ Your request will be cancelled soon if we don\'t receive payment.' : '';
        await this.twilioService.sendWhatsAppMessage(
          customerPhone,
          `⏰ Reminder — tap the link below to pay and confirm your rescue:\n\n👉 ${paymentUrl}${warning}`,
        );
      }, markMs);
    }

    setTimeout(async () => {
      const claimed = await this.prisma.rescueRequest.updateMany({
        where: { id: rescueRequestId, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      if (claimed.count === 0) return; // the payment webhook won the race — nothing to do

      // The customer's session was set to OPERATOR_FOUND_WAITING_PAYMENT when
      // the deposit flow started. Reset it now so a follow-up WhatsApp
      // message doesn't hit stale state and get told to pay a request that
      // was just cancelled.
      await this.sessionStore.update(customerId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });

      await this.prisma.dispatchOffer.updateMany({
        where: { rescueRequestId, status: DispatchOfferStatus.SELECTED_PENDING_PAYMENT },
        data: { status: DispatchOfferStatus.TIMED_OUT, respondedAt: new Date() },
      });
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `We didn't receive payment confirmation within 30 minutes, so your request was cancelled. If your payment completes after this, we'll refund it.`,
      );
      await this.twilioService.sendWhatsAppMessage(
        operatorPhone,
        `⏰ This job is no longer available — the customer didn't pay in time.`,
      );
    }, this.DEPOSIT_WINDOW_MS);
  }
}
