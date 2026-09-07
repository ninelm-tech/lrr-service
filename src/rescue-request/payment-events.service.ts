import { BadRequestException, Injectable, forwardRef, Inject } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { RescueRequestStatus, VehicleType } from '@prisma/client';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatVehicleType } from './domain/vehicle-truck-mapping';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { DispatchService } from './dispatch.service';
// scheduleRatingTimeout closes a real two-way dependency with this service
// (this needs scheduleRatingTimeout; WhatsAppCustomerFlowService needs
// markJobCompleted for its CONFIRM branch) — forwardRef required on both sides.
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

@Injectable()
export class PaymentEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly payoutService: PayoutService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly sharedService: RescueRequestSharedService,
    private readonly dispatchService: DispatchService,
    @Inject(forwardRef(() => WhatsAppCustomerFlowService))
    private readonly customerFlowService: WhatsAppCustomerFlowService,
  ) {}

  async handleDepositPaymentConfirmed(reference: string) {
    console.log('🔍 Deposit confirmed, reference:', reference);

    const rescueRequest = await this.prisma.rescueRequest.findFirst({
      where:   { depositReference: reference },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) {
      console.error('❌ No rescue request for deposit reference:', reference);
      Sentry.captureMessage(`Deposit webhook: no request found for reference ${reference}`, 'error');
      return;
    }

    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;

    // Mark deposit paid and fully confirm the operator assignment — atomic
    // claim, not an unconditional write. count === 0 means the WHERE didn't
    // match; see handleUnclaimedDeposit for why that's ambiguous and must
    // not be treated as "always late payment."
    const claimed = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequest.id, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
      data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
    });
    if (claimed.count === 0) {
      await this.handleUnclaimedDeposit(rescueRequest.id, reference);
      return;
    }

    // The offer is only actually awarded now that payment is confirmed —
    // selection alone (Task 8) only reached SELECTED_PENDING_PAYMENT.
    if (rescueRequest.assignedOperatorId) {
      await this.prisma.dispatchOffer.updateMany({
        where: {
          rescueRequestId: rescueRequest.id,
          operatorId: rescueRequest.assignedOperatorId,
          status: 'SELECTED_PENDING_PAYMENT',
        },
        data: { status: 'ACCEPTED' },
      });
    }

    const operator = rescueRequest.assignedOperator;

    // Customer: confirmed with operator details
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.REQUEST_CONFIRMED,
    });
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        operator
          ? `✅ *Payment confirmed — operator is on the way!*\n\nBusiness: ${operator.businessName}\nPhone: ${operator.phoneNumber}\n\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}\n\nYou'll be notified when they arrive.`
          : `✅ Deposit confirmed! Finding the nearest tow operator...`,
      );
    }

    if (operator) {
      // Operator: job is now live — send customer location + details
      const opUser = await this.sharedService.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state:           WhatsAppFlowState.OPERATOR_ON_JOB,
        rescueRequestId: rescueRequest.id,
      });
      const lat = Number(rescueRequest.latitude);
      const lon = Number(rescueRequest.longitude);
      const locationSection = await this.sharedService.formatLocationSection(lat, lon);
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💰 *Payment confirmed — job is live!*\n\nCustomer: ${customerPhone}\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}\nLocation: ${locationSection}\n\nHead over now and send *ARRIVED* when you reach them.`,
      );
    } else {
      // Edge case: no operator was pre-assigned (e.g. admin manually sent a payment link)
      void this.dispatchService.startDispatch(rescueRequest.id, customerId);
    }
  }

  /**
   * claimed.count === 0 on the confirmed-payment claim is ambiguous — it means
   * EITHER a Paystack webhook redelivery of a payment we already successfully
   * processed, OR a genuinely late payment arriving after the request moved
   * on. These must not be conflated: see
   * docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
   * Section 2.
   */
  private async handleUnclaimedDeposit(rescueRequestId: string, reference: string): Promise<void> {
    const fresh = await this.prisma.rescueRequest.findUniqueOrThrow({
      where:   { id: rescueRequestId },
      include: { customer: true },
    });

    if (fresh.depositPaid) {
      logger.info('deposit: duplicate confirmation ignored', { rescueRequestId, reference });
      return;
    }

    if (fresh.status === RescueRequestStatus.CANCELLED) {
      await this.handleLateDeposit(fresh, reference);
      return;
    }

    console.error(`Deposit confirmed for request ${rescueRequestId} in unexpected status ${fresh.status}`, { reference });
    Sentry.captureMessage('Deposit confirmed in unexpected (non-CANCELLED) status', {
      level: 'error',
      extra: { rescueRequestId, reference, status: fresh.status },
    });
  }

  /**
   * The only place in the codebase that writes RefundStatus.ELIGIBLE — this
   * is deliberate. It means "a deposit arrived for a request that has already
   * moved on with nothing paid yet," which is exactly and only what this
   * feature's refund path is for. Do not write ELIGIBLE anywhere else.
   */
  private async handleLateDeposit(rescueRequest: { id: string; customer: { phoneNumber: string | null } }, reference: string): Promise<void> {
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositPaid: true, depositRefundStatus: 'ELIGIBLE' },
    });
    if (rescueRequest.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        rescueRequest.customer.phoneNumber,
        `Your payment for a cancelled request has come through. We're processing a refund — you'll be notified once it's complete.`,
      );
    }
    logger.info('deposit: late payment on a non-WAITING_FOR_DEPOSIT request', { rescueRequestId: rescueRequest.id, reference });
  }

  async handleBalancePaymentConfirmed(reference: string) {
    console.log('💰 Balance confirmed, reference:', reference);

    const rescueRequest = await this.prisma.rescueRequest.findFirst({
      where: { balanceReference: reference },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) {
      console.error('❌ No rescue request for balance reference:', reference);
      Sentry.captureMessage(`Balance webhook: no request found for reference ${reference}`, 'error');
      return;
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { balancePaid: true, status: RescueRequestStatus.COMPLETED },
    });

    // Notify customer — payment confirmed, then prompt to rate the operator
    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;
    const balanceNaira  = ((rescueRequest.balanceAmount ?? 0) / 100).toLocaleString();
    const operator = rescueRequest.assignedOperator;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Local Roadside Rescue 🙏`,
      );
      const operatorName = operator?.businessName ?? 'your operator';
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
      const hasPortalAccount = Boolean(rescueRequest.customer.email && rescueRequest.customer.passwordHash);
      const portalLine = hasPortalAccount
        ? `\n\nWant to see your receipt? Log in at ${frontendUrl}/login`
        : `\n\nWant to see your receipt and past requests? Create an account at ${frontendUrl}/register/customer`;
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `How was your experience with ${operatorName}? Reply with a number from 1 to 5 to rate them.${portalLine}`,
      );
    }
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.WAITING_FOR_RATING,
      rescueRequestId: rescueRequest.id,
    });
    this.customerFlowService.scheduleRatingTimeout(customerId, rescueRequest.id);

    // Notify operator — release the vehicle, then prompt to rate the motorist
    if (operator?.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💵 *Payment received!*\n\nThe customer has paid the ₦${balanceNaira} balance in full.\n\n✅ You may now *release the vehicle*. Job complete — well done!\n\nYour payment will be remitted within 24 hours.`,
      );
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `How was your experience with this customer? Reply with a number from 1 to 5 to rate them.`,
      );
      const opUser = await this.sharedService.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.WAITING_FOR_RATING,
        rescueRequestId: rescueRequest.id,
      });
      this.customerFlowService.scheduleRatingTimeout(opUser.id, rescueRequest.id);
    }

    if (rescueRequest.assignedOperatorId) {
      const payoutAmount = (rescueRequest.depositAmount ?? 0) + (rescueRequest.balanceAmount ?? 0) - (rescueRequest.serviceFeeAmount ?? 0);
      await this.payoutService.createAndProcessPayout(rescueRequest.id, rescueRequest.assignedOperatorId, payoutAmount);
    }

    console.log(`✅ Job ${rescueRequest.id} completed — operator and customer notified`);
  }

  async markJobCompleted(rescueRequestId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) throw new Error('Rescue request not found');

    // A request under active dispute must not proceed to the balance
    // payment / payout stage — staff have to resolve it first (see
    // DisputeService.resolveDispute). Without this guard, the admin
    // "mark completed" shortcut (and a customer replying CONFIRM after
    // DISPUTE, since the session state doesn't change on dispute) both
    // bypass the WhatsApp CONFIRM/DISPUTE fork entirely.
    if (rescueRequest.disputed && !rescueRequest.disputeResolvedAt) {
      throw new BadRequestException('This request has an unresolved dispute — resolve it before marking the job completed.');
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data:  { status: RescueRequestStatus.COMPLETED },
    });

    if (!rescueRequest.balancePaid) {
      await this.sendBalancePaymentLink(rescueRequest);
    }
  }

  private async sendBalancePaymentLink(rescueRequest: any) {
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (!customerPhone) return;

    const balanceAmount = rescueRequest.balanceAmount;
    if (!balanceAmount) {
      console.error('No balanceAmount persisted for rescue request:', rescueRequest.id);
      Sentry.captureMessage(`sendBalancePaymentLink: missing balanceAmount for ${rescueRequest.id}`, 'error');
      return;
    }

    const reference = this.paystackService.generateReference('BAL');
    const email = rescueRequest.customer.email || `${customerPhone.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: balanceAmount,
      reference,
      metadata: {
        rescueRequestId: rescueRequest.id,
        customerId:      rescueRequest.customerId,
        phoneNumber:     customerPhone,
        type: 'balance',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to create balance payment link:', paymentResponse);
      return;
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { balanceReference: reference },
    });

    const balanceNaira = (balanceAmount / 100).toLocaleString();
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `✅ Your tow is complete!\n\n⚠️ *ACTION NEEDED* — tap the link below to pay the ₦${balanceNaira} balance:\n\n👉 ${paymentResponse.data.authorization_url}\n\nThank you for using Local Roadside Rescue 🚗`,
    );
  }
}
