import { Injectable, forwardRef, Inject } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { RescueRequestStatus, VehicleType } from '@prisma/client';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatVehicleType } from './domain/vehicle-truck-mapping';
// Temporary — findOrCreateCustomer/formatLocationSection haven't been
// extracted to their real home yet (WhatsAppInboundService is a later task
// in the same decomposition). Depending on the old service for just these
// two calls is intentional and temporary, not a new permanent coupling —
// narrows to nothing once that task lands.
import { RescueRequestService } from './rescue-request.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

@Injectable()
export class PaymentEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly payoutService: PayoutService,
    private readonly sessionStore: WhatsAppSessionStore,
    @Inject(forwardRef(() => RescueRequestService))
    private readonly rescueRequestService: RescueRequestService,
    @Inject(forwardRef(() => DispatchService))
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

    // Mark deposit paid and fully confirm the operator assignment
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
    });

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
      const opUser = await this.rescueRequestService.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state:           WhatsAppFlowState.OPERATOR_ON_JOB,
        rescueRequestId: rescueRequest.id,
      });
      const lat = Number(rescueRequest.latitude);
      const lon = Number(rescueRequest.longitude);
      const locationSection = await this.rescueRequestService.formatLocationSection(lat, lon);
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💰 *Payment confirmed — job is live!*\n\nCustomer: ${customerPhone}\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}\nLocation: ${locationSection}\n\nHead over now and send *ARRIVED* when you reach them.`,
      );
    } else {
      // Edge case: no operator was pre-assigned (e.g. admin manually sent a payment link)
      void this.dispatchService.startDispatch(rescueRequest.id, customerId);
    }
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
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Lagos Roadside Rescue 🙏`,
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
      const opUser = await this.rescueRequestService.findOrCreateCustomer(operator.phoneNumber);
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
      `✅ Your tow is complete!\n\n⚠️ *ACTION NEEDED* — tap the link below to pay the ₦${balanceNaira} balance:\n\n👉 ${paymentResponse.data.authorization_url}\n\nThank you for using Lagos Roadside Rescue 🚗`,
    );
  }
}
