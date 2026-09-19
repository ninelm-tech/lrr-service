import {
  BadRequestException,
  Injectable,
  forwardRef,
  Inject,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { Payment, Prisma, RescueRequestStatus } from '@prisma/client';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatVehicleType } from './domain/vehicle-truck-mapping';
import { formatJobRef } from './domain/rescue-request-formatting';
import { hasSucceededPayment } from './domain/derive-payment-state';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { BalancePaymentTarget } from './dto/balance-payment-target.dto';
import { DispatchService } from './dispatch.service';
// A real two-way dependency with this service
// (WhatsAppCustomerFlowService needs
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
    private readonly paymentLedger: PaymentLedgerService,
    private readonly paystackCustomerService: PaystackCustomerService,
  ) {}

  /**
   * Runs the business side effects of a settled DEPOSIT payment — assigning
   * the operator, notifying both parties, starting dispatch if none was
   * pre-assigned.
   *
   * Callable from two places, deliberately: the webhook (the fast path) and
   * PaymentVerifyCheck's own success claim (the backstop, when a webhook is
   * lost). Both call this ONLY after THEIR OWN claim on the Payment row's
   * terminal state actually won — that CAS is what used to be
   * depositPaid-based idempotency (a webhook redelivery, or a race between
   * the two callers, now finds nothing left to claim and never reaches
   * here), so this method itself needs no separate claim of its own.
   */
  async confirmDeposit(payment: Payment): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUniqueOrThrow({
      where: { id: payment.rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });

    if (rescueRequest.status === RescueRequestStatus.CANCELLED) {
      // The deposit landed after the request already moved on — see
      // handleLateDeposit. Refund eligibility is now purely derived (a
      // succeeded DEPOSIT on a CANCELLED request), so nothing further needs
      // recording here beyond the notification.
      await this.handleLateDeposit(rescueRequest);
      return;
    }
    if (rescueRequest.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) {
      console.error(
        `Deposit confirmed for request ${rescueRequest.id} in unexpected status ${rescueRequest.status}`,
      );
      Sentry.captureMessage(
        'Deposit confirmed in unexpected (non-CANCELLED) status',
        {
          level: 'error',
          extra: {
            rescueRequestId: rescueRequest.id,
            paymentId: payment.id,
            status: rescueRequest.status,
          },
        },
      );
      return;
    }

    const customerId = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data: { status: RescueRequestStatus.OPERATOR_ASSIGNED },
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
          ? `✅ *Payment confirmed — operator is on the way!*\n\nBusiness: ${operator.businessName}\nPhone: ${operator.phoneNumber}\n\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType) : 'Unknown'}\n\nYou'll be notified when they arrive.`
          : `✅ Deposit confirmed! Finding the nearest tow operator...`,
      );
    }

    if (operator) {
      // Operator: job is now live — send customer location + details
      const opUser = await this.sharedService.findOrCreateCustomer(
        operator.phoneNumber,
      );
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.OPERATOR_ON_JOB,
        rescueRequestId: rescueRequest.id,
      });
      const lat = Number(rescueRequest.latitude);
      const lon = Number(rescueRequest.longitude);
      const locationSection = await this.sharedService.formatLocationSection(
        lat,
        lon,
      );
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💰 *Payment confirmed — job is live!* — ${formatJobRef(rescueRequest.id)}\n\nCustomer: ${customerPhone}\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType) : 'Unknown'}\nLocation: ${locationSection}\n\nHead over now and send *ARRIVED* when you reach them.`,
      );
    } else {
      // Edge case: no operator was pre-assigned (e.g. admin manually sent a payment link)
      void this.dispatchService.startDispatch(rescueRequest.id, customerId);
    }
  }

  /**
   * The deposit arrived after its request already moved on with nothing
   * paid — refund eligibility is now purely derived (see
   * domain/derive-payment-state.ts), so this is only the notification.
   */
  private async handleLateDeposit(rescueRequest: {
    id: string;
    customer: { phoneNumber: string | null };
  }): Promise<void> {
    if (rescueRequest.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        rescueRequest.customer.phoneNumber,
        `Your payment for a cancelled request has come through. We're processing a refund — you'll be notified once it's complete.`,
      );
    }
    logger.info('deposit: late payment on a non-WAITING_FOR_DEPOSIT request', {
      rescueRequestId: rescueRequest.id,
    });
  }

  /**
   * Runs the business side effects of a settled BALANCE payment — completing
   * the job, notifying both parties, prompting ratings, triggering the
   * payout. Same calling contract as confirmDeposit: only ever called after
   * the caller's own claim on the Payment row won.
   */
  async confirmBalance(payment: Payment): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUniqueOrThrow({
      where: { id: payment.rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });

    // Unconditional, not a claim: the Payment row's own CAS is what
    // guarantees exactly one caller reaches here per settlement. Status may
    // already be COMPLETED (markJobCompleted sets it before payment lands)
    // or IN_DISPUTE (resolveDispute leaves it there deliberately) — this
    // write is correct either way.
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data: { status: RescueRequestStatus.COMPLETED },
    });

    // The job is over — release any chat relay before the rating prompts
    // below land, since an open relay would otherwise swallow the replies
    // to them (and every later message from both parties).
    await this.sharedService.endRelayForEndedRequest(rescueRequest.id);

    // Notify customer — payment confirmed, then prompt to rate the operator
    const customerId = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;
    const balanceNaira = (
      (rescueRequest.balanceAmount ?? 0) / 100
    ).toLocaleString();
    const operator = rescueRequest.assignedOperator;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Local Roadside Rescue 🙏`,
      );
      const operatorName = operator?.businessName ?? 'your operator';
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
      const hasPortalAccount = Boolean(
        rescueRequest.customer.email && rescueRequest.customer.passwordHash,
      );
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

    // Notify operator — release the vehicle, then prompt to rate the motorist
    //
    // Both messages carry the job ref: an operator can have more than one
    // job in flight (no busy filter — see operator.service.ts), so a
    // message that doesn't say which job it's about is ambiguous to them
    // even though the customer-facing equivalent above never needs it (a
    // motorist only ever has one active request).
    if (operator?.phoneNumber) {
      const jobRef = formatJobRef(rescueRequest.id);
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💵 *Payment received!* — ${jobRef}\n\nThe customer has paid the ₦${balanceNaira} balance in full.\n\n✅ You may now *release the vehicle*. Job complete — well done!\n\nYour payment will be remitted within 24 hours.`,
      );
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `How was your experience with this customer? — ${jobRef}\n\nReply with a number from 1 to 5 to rate them.`,
      );
      const opUser = await this.sharedService.findOrCreateCustomer(
        operator.phoneNumber,
      );
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.WAITING_FOR_RATING,
        rescueRequestId: rescueRequest.id,
      });
    }

    if (rescueRequest.assignedOperatorId) {
      const payoutAmount =
        (rescueRequest.depositAmount ?? 0) +
        (rescueRequest.balanceAmount ?? 0) -
        (rescueRequest.serviceFeeAmount ?? 0);
      await this.payoutService.createAndProcessPayout(
        rescueRequest.id,
        rescueRequest.assignedOperatorId,
        payoutAmount,
      );
    }

    console.log(
      `✅ Job ${rescueRequest.id} completed — operator and customer notified`,
    );
  }

  async markJobCompleted(rescueRequestId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: {
        customer: true,
        payments: { select: { type: true, status: true } },
      },
    });
    if (!rescueRequest) throw new Error('Rescue request not found');

    // Once a request has ever been disputed, markJobCompleted is
    // permanently the wrong path for it — DisputeService.resolveDispute
    // sends its own (possibly adjusted) settlement payment link directly,
    // and status only becomes COMPLETED once that's actually paid
    // (confirmBalance). Blocking here regardless of
    // disputeResolvedAt stops a customer's CONFIRM (still possible while
    // their session sits in AWAITING_COMPLETION_CONFIRM) from sending a
    // second, wrong-amount payment link or completing the job before
    // payment — both the admin "mark completed" shortcut and a same-message
    // CONFIRM/DISPUTE race were the two ways this used to be bypassed.
    if (rescueRequest.disputed) {
      throw new BadRequestException(
        'This request has an unresolved dispute — resolve it before marking the job completed.',
      );
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.COMPLETED },
    });

    if (!hasSucceededPayment(rescueRequest.payments, 'BALANCE')) {
      await this.sendBalancePaymentLink(rescueRequest);
    }
  }

  async sendBalancePaymentLink(rescueRequest: BalancePaymentTarget) {
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (!customerPhone) return;

    const balanceAmount = rescueRequest.balanceAmount;
    if (!balanceAmount) {
      console.error(
        'No balanceAmount persisted for rescue request:',
        rescueRequest.id,
      );
      Sentry.captureMessage(
        `sendBalancePaymentLink: missing balanceAmount for ${rescueRequest.id}`,
        'error',
      );
      return;
    }

    // The same protocol as the deposit paths: commit, claim, call, classify.
    //
    // The insert can be refused by the in-flight unique index when a balance
    // payment already exists for this request — reachable via dispute
    // resolution, which sends a settlement link for a request that may
    // already have had one. Resolving that stale attempt is a design question
    // the payment model does not answer yet (the settled amount differs, so
    // the old link is wrong, but a SUBMITTED row must never be failed
    // blindly). Until it does: never throw out of here. Throwing would fail
    // the caller's dispute resolution AFTER it has already written the
    // settled amount. Alert instead, so a human issues the link.
    let payment;
    try {
      payment = await this.paymentLedger.create({
        rescueRequestId: rescueRequest.id,
        type: 'BALANCE',
        amount: balanceAmount,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        Sentry.captureMessage(
          'Balance link skipped — a balance payment is already in flight',
          {
            level: 'error',
            extra: { rescueRequestId: rescueRequest.id, balanceAmount },
          },
        );
        return;
      }
      throw error;
    }
    if (
      !(await this.paymentLedger.claimForSubmission(payment.id, new Date()))
    ) {
      return; // another caller owns this one
    }
    const reference = this.paymentLedger.referenceFor(payment);
    // Never build the identity email inline — see PaystackCustomerService.
    const { email } = await this.paystackCustomerService.customerFor(
      rescueRequest.customerId,
    );

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: balanceAmount,
      reference,
      metadata: {
        rescueRequestId: rescueRequest.id,
        customerId: rescueRequest.customerId,
        phoneNumber: customerPhone,
        type: 'balance',
      },
    });

    if (paymentResponse.outcome === 'ambiguous') {
      // Leaves the row SUBMITTED with checkoutUrl null — recovery's signal
      // that no link ever reached the customer.
      console.error('Paystack initialize was inconclusive:', paymentResponse);
      return;
    }
    if (paymentResponse.outcome === 'rejected') {
      await this.paymentLedger.recordRejection(
        payment.id,
        paymentResponse.message ?? 'initialize rejected',
      );
      return;
    }

    const checkoutUrl = paymentResponse.data.authorization_url;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutUrl },
    });
    // No RescueRequest field to persist this reference into — unlike a
    // deposit, a balance payment has no reminder path that would need to
    // find the request from it later. The Payment row is the only record.

    const balanceNaira = (balanceAmount / 100).toLocaleString();
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `✅ Your tow is complete!\n\n⚠️ *ACTION NEEDED* — tap the link below to pay the ₦${balanceNaira} balance:\n\n👉 ${checkoutUrl}\n\nThank you for using Local Roadside Rescue 🚗`,
    );
  }
}
