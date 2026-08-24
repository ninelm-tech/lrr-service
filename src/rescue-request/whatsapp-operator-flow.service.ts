import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { RescueRequestStatus, RatingDirection } from '@prisma/client';
import { formatJobRef } from './domain/rescue-request-formatting';
import { DispatchService } from './dispatch.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { toWhatsAppAddress } from '../common/phone.util';

@Injectable()
export class WhatsAppOperatorFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly dispatchService: DispatchService,
    private readonly paymentEventsService: PaymentEventsService,
    private readonly customerFlowService: WhatsAppCustomerFlowService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  //  Operator message router
  // ──────────────────────────────────────────────────────────────────────────
  async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // ── Waiting for post-job rating (operator rates motorist) ─────────────
    // MUST come before the quote-parsing check below, which treats any bare
    // digit as a dispatch-offer price quote — without this ordering, a
    // rating reply would be silently swallowed as a bogus quote attempt.
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.customerFlowService.handleRatingReply(
        userId, message, session.rescueRequestId, RatingDirection.OPERATOR_TO_MOTORIST,
      );
    }

    // ── Dispatch quote / decline ─────────────────────────────────────────
    // "JOBREF PRICE" / "JOBREF NO" disambiguates which job this reply is for
    // when an operator has more than one offer open at once — see
    // handleOperatorQuoteOrDecline for what happens when it's left out.
    const refAndDecline = message.match(/^([a-z0-9]{6})\s+(no|decline)$/i);
    if (refAndDecline) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined, refAndDecline[1].toUpperCase());
    }
    const refAndPrice = message.match(/^([a-z0-9]{6})\s+(\d+)$/i);
    if (refAndPrice) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(refAndPrice[2]) * 100, refAndPrice[1].toUpperCase());
    }
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(message) * 100);
    }

    // ── ARRIVED at customer location ───────────────────────────────────────
    if (message === 'arrived' || message === 'on site' || message === 'onsite') {
      if (session.state !== WhatsAppFlowState.OPERATOR_ON_JOB || !session.rescueRequestId) {
        return this.reply(`You don't have an active job. Wait for a dispatch offer.`);
      }
      return this.handleOperatorArrived(phoneNumber, userId, session.rescueRequestId, operator);
    }

    // ── Job DONE — prompt customer to confirm ──────────────────────────────
    if (message === 'done' || message === 'complete' || message === 'finished') {
      if (session.state !== WhatsAppFlowState.OPERATOR_AT_LOCATION || !session.rescueRequestId) {
        return this.reply(`Please send ARRIVED first when you reach the customer location.`);
      }
      return this.handleOperatorJobDone(phoneNumber, userId, session.rescueRequestId, operator);
    }

    // ── Contextual help ───────────────────────────────────────────────────
    if (session.state === WhatsAppFlowState.OPERATOR_ON_JOB) {
      return this.reply(
        `📍 Send *ARRIVED* when you reach the customer location so we can notify them.`,
      );
    }
    if (session.state === WhatsAppFlowState.OPERATOR_AT_LOCATION) {
      return this.reply(
        `✅ Send *DONE* when the job is complete. The customer will confirm and you'll both be notified.`,
      );
    }

    return this.xmlOk();
  }

  /**
   * Operator replied to a dispatch offer with either a price (quote) or NO
   * (decline) over WhatsApp. `quotedPriceKobo` is undefined for a decline.
   *
   * `jobRef` is the 6-char tag from formatJobRef, present when the operator
   * replied "JOBREF PRICE" instead of a bare price. With only one offer
   * pending, a bare reply is unambiguous and works as before. With more than
   * one pending, guessing which job a bare reply is for is exactly the bug
   * this disambiguates — the previous behavior (most-recently-offered wins)
   * could silently apply a quote to the wrong job.
   */
  private async handleOperatorQuoteOrDecline(
    operatorPhone: string,
    operatorUserId: string,
    quotedPriceKobo: number | undefined,
    jobRef?: string,
  ) {
    const operator = await this.prisma.operator.findUnique({
      where: { phoneNumber: operatorPhone },
    });
    if (!operator) return this.xmlOk();

    // expiresAt is filtered here, not just relied on via status: an offer is
    // only flipped to TIMED_OUT by resolveBatch or the sweeper, so between a
    // restart and the next sweep there can be PENDING rows that are long
    // dead. Without this filter they count toward "how many jobs are open",
    // and the operator gets asked to disambiguate between jobs that ended
    // days ago. The dashboard equivalent (listMyPendingOffers) already
    // filters this way — this brings the WhatsApp path in line.
    const pendingOffers = await this.prisma.dispatchOffer.findMany({
      where: { operatorId: operator.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { offeredAt: 'desc' },
    });
    if (pendingOffers.length === 0) return this.xmlOk();

    let offer = pendingOffers[0];
    if (jobRef) {
      const matched = pendingOffers.find((o) => formatJobRef(o.rescueRequestId).endsWith(jobRef));
      if (!matched) {
        return this.reply(`That job reference doesn't match any of your open offers. Reply "NO" or just your price if you only have one job open.`);
      }
      offer = matched;
    } else if (pendingOffers.length > 1) {
      const list = pendingOffers
        .map((o) => `• ${formatJobRef(o.rescueRequestId)}`)
        .join('\n');
      return this.reply(
        `You have ${pendingOffers.length} jobs open at once — reply with the job reference and your price so we know which one, e.g. "${formatJobRef(pendingOffers[0].rescueRequestId).replace('Job #', '')} 25000":\n\n${list}`,
      );
    }

    const result = await this.dispatchService.processQuoteOrDecline(offer, quotedPriceKobo);
    return this.reply(result.message);
  }

  private async handleOperatorArrived(
    operatorPhone: string,
    operatorUserId: string,
    rescueRequestId: string,
    operator: { id: string; businessName: string },
  ) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest || rescueRequest.status === RescueRequestStatus.CANCELLED || rescueRequest.status === RescueRequestStatus.COMPLETED) {
      await this.sessionStore.clear(operatorUserId);
      return this.reply(`This job has already ended. Watch out for new dispatch offers.`);
    }

    // Update request status to ARRIVED
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.ARRIVED },
    });

    // Operator session → AT_LOCATION
    await this.sessionStore.update(operatorUserId, {
      state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
    });

    // Notify customer
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 Your tow operator has arrived!\n\nBusiness: *${operator.businessName}*\n\nThey're at your location. Please show them your vehicle.`,
      );
    }

    return this.reply(`✅ Arrival confirmed! The customer has been notified.\n\nSend *DONE* when the job is complete.`);
  }

  private async handleOperatorJobDone(
    operatorPhone: string,
    operatorUserId: string,
    rescueRequestId: string,
    operator: { id: string; businessName: string },
  ) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest || rescueRequest.status === RescueRequestStatus.CANCELLED || rescueRequest.status === RescueRequestStatus.COMPLETED) {
      await this.sessionStore.clear(operatorUserId);
      return this.reply(`This job has already ended.`);
    }

    const customerPhone = rescueRequest.customer.phoneNumber;
    const customerId    = rescueRequest.customerId;

    // Put customer session in AWAITING_COMPLETION_CONFIRM
    if (customerId) {
      await this.sessionStore.update(customerId, {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
        rescueRequestId,
      });
    }
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🔧 ${operator.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
      );
    }

    // Auto-complete after 30 minutes if customer doesn't respond
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh && fresh.status !== RescueRequestStatus.COMPLETED && fresh.status !== RescueRequestStatus.CANCELLED) {
        console.log(`⏱ Auto-completing request ${rescueRequestId} — customer did not confirm in 30 min`);
        await this.paymentEventsService.markJobCompleted(rescueRequestId);
        await this.sessionStore.update(customerId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, 30 * 60 * 1000);

    await this.sessionStore.update(operatorUserId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });

    return this.reply(
      `✅ Job marked as done! Waiting for customer confirmation.\n\nIf they confirm, you'll receive a notification. Thank you 🙏`,
    );
  }

  private reply(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>${message}</Message>\n</Response>`;
  }

  private xmlOk(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;
  }
}
