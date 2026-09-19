import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PaymentEventsService } from './payment-events.service';
import {
  Payment,
  PaymentStatus,
  PaymentType,
  Prisma,
  RescueRequestStatus,
} from '@prisma/client';
import { toWhatsAppAddress } from '../common/phone.util';
import { DEPOSIT_WINDOW_MS } from './deposit.constants';
import {
  RescueRequestListResponseDto,
  RescueRequestListItemDto,
  RescueRequestDetailResponseDto,
  RescueRequestDetailDto,
  DispatchOfferAdminDto,
  PaginationMetaDto,
} from './dto/rescue-request-response.dto';
import { RequestMediaDto } from '../media/dto/request-media.dto';
import { DispatchService } from './dispatch.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { OperatorMembershipService } from '../operator/operator-membership.service';
import { mapRefundStatus } from '../payment/domain/paystack-status';
import {
  deriveRefundStatus,
  hasSucceededPayment,
  refundEligiblePaymentsFilter,
} from './domain/derive-payment-state';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';

@Injectable()
export class RescueRequestAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly paymentEventsService: PaymentEventsService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
    private readonly sharedService: RescueRequestSharedService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly paymentLedger: PaymentLedgerService,
    private readonly paystackCustomerService: PaystackCustomerService,
    private readonly operatorMembershipService: OperatorMembershipService,
  ) {}

  async adminList(query: any) {
    const {
      status,
      issueType,
      operatorId,
      depositPaid,
      balancePaid,
      refundEligible,
      from,
      to,
      search,
      page = 1,
      limit = 20,
    } = query;

    const where: any = {};
    if (status) where.status = status;
    if (issueType) where.issueType = issueType;
    if (operatorId) where.assignedOperatorId = operatorId;

    const paymentFilters = this.buildPaymentFilters({
      depositPaid,
      balancePaid,
    });
    if (refundEligible === 'true' || refundEligible === true) {
      where.status = RescueRequestStatus.CANCELLED;
      paymentFilters.push({ payments: refundEligiblePaymentsFilter() });
    }
    if (paymentFilters.length > 0) where.AND = paymentFilters;

    if (from && to)
      where.createdAt = { gte: new Date(from), lte: new Date(to) };
    if (search) {
      where.OR = [
        {
          customer: { phoneNumber: { contains: search, mode: 'insensitive' } },
        },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    return this.buildListResponse(where, Number(page), Number(limit));
  }

  /**
   * Manually assign an operator with an admin-agreed price. Runs the same
   * fee split and deposit-payment-link flow as a customer selecting a quote
   * themselves (see handleQuoteSelected) — the admin is standing in for the
   * bidding round, not skipping payment collection.
   *
   * Manual validation, not just the DTO's decorators — this app has no
   * global ValidationPipe wired up yet, so class-validator decorators alone
   * don't currently run (see rating.controller.ts for the same gap).
   */
  async assignOperator(
    id: string,
    dto: { operatorId: string; priceKobo: number },
  ) {
    if (!dto.operatorId)
      throw new BadRequestException('operatorId is required');
    if (!Number.isInteger(dto.priceKobo) || dto.priceKobo <= 0) {
      throw new BadRequestException('priceKobo must be a positive integer');
    }

    const operator = await this.prisma.operator.findUnique({
      where: { id: dto.operatorId },
    });
    if (!operator) throw new NotFoundException('Operator not found');
    if (operator.status !== 'ACTIVE')
      throw new BadRequestException('Target is not an active operator');

    const request = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: { customer: true },
    });
    if (!request) throw new NotFoundException('Rescue request not found');
    if (
      (
        [
          RescueRequestStatus.COMPLETED,
          RescueRequestStatus.CANCELLED,
        ] as RescueRequestStatus[]
      ).includes(request.status)
    ) {
      throw new BadRequestException(
        `Cannot assign an operator to a ${request.status} request`,
      );
    }
    if (!request.customer.phoneNumber) {
      throw new BadRequestException(
        'Customer has no phone number on file — cannot send a payment link',
      );
    }

    const config = await this.platformConfigService.getConfig();
    const serviceFeeAmount = Math.round(
      (dto.priceKobo * config.serviceFeePercent) / 100,
    );
    const total = dto.priceKobo + serviceFeeAmount;
    const depositAmount = Math.round((total * config.depositPercent) / 100);
    const balanceAmount = total - depositAmount;

    const MANUAL_ASSIGN_WINDOW_MS = 30 * 60 * 1000;
    const batchId = crypto.randomUUID();
    const depositWindowExpiresAt = new Date(Date.now() + DEPOSIT_WINDOW_MS);
    let payment: Payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const customerStillActive = await tx.user.updateMany({
          where: { id: request.customerId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (customerStillActive.count === 0) {
          throw new BadRequestException(
            'Cannot assign an operator: this customer has been deleted.',
          );
        }

        const operatorStillActive = await tx.operator.updateMany({
          where: { id: dto.operatorId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (operatorStillActive.count === 0) {
          throw new BadRequestException(
            'Cannot assign this operator: the account has been deleted.',
          );
        }

        const claimed = await tx.rescueRequest.updateMany({
          where: {
            id,
            status: request.status,
            assignedOperatorId: request.assignedOperatorId,
          },
          data: {
            assignedOperatorId: dto.operatorId,
            status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
            serviceFeeAmount,
            depositAmount,
            balanceAmount,
            depositWindowExpiresAt,
            depositRemindersSent: 0,
          },
        });
        if (claimed.count === 0) {
          throw new BadRequestException(
            'This request has already been assigned or moved on.',
          );
        }

        await tx.dispatchOffer.create({
          data: {
            rescueRequestId: id,
            operatorId: dto.operatorId,
            status: 'SELECTED_PENDING_PAYMENT',
            quotedPrice: dto.priceKobo,
            respondedAt: new Date(),
            expiresAt: new Date(Date.now() + MANUAL_ASSIGN_WINDOW_MS),
            batchId,
            dispatchRound: request.dispatchRound,
          },
        });

        return this.paymentLedger.create({
          rescueRequestId: id,
          type: 'DEPOSIT',
          amount: depositAmount,
          tx,
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(
          `A deposit is already in flight for this request — check its status before assigning again`,
        );
      }
      throw error;
    }
    if (
      !(await this.paymentLedger.claimForSubmission(payment.id, new Date()))
    ) {
      throw new BadRequestException(
        `A deposit is already being set up for this request`,
      );
    }
    const reference = this.paymentLedger.referenceFor(payment);
    // Never request.customer.email directly — see PaystackCustomerService.
    const { email } = await this.paystackCustomerService.customerFor(
      request.customerId,
    );
    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: depositAmount,
      reference,
      metadata: {
        rescueRequestId: id,
        customerId: request.customerId,
        phoneNumber: request.customer.phoneNumber,
        type: 'deposit',
      },
    });

    if (paymentResponse.outcome !== 'ok') {
      // Only a definitive rejection fails the payment. An ambiguous result
      // leaves it SUBMITTED for verification — the admin is told not to
      // retry, because a retry here would be a second transaction.
      if (paymentResponse.outcome === 'rejected') {
        await this.paymentLedger.recordRejection(
          payment.id,
          paymentResponse.message ?? 'initialize rejected',
        );
        throw new BadRequestException(
          `Couldn't generate a payment link — please try again`,
        );
      }
      throw new BadRequestException(
        `Payment link status unknown — it is being verified. Do not retry yet.`,
      );
    }

    const checkoutUrl = paymentResponse.data.authorization_url;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutUrl },
    });

    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data: {
        depositPaymentUrl: checkoutUrl,
      },
      include: {
        customer: true,
        assignedOperator: true,
        payments: { select: { id: true, type: true, status: true } },
      },
    });

    const customerPhone = toWhatsAppAddress(request.customer.phoneNumber);
    const operatorPhone = toWhatsAppAddress(operator.phoneNumber!);
    const depositNaira = (depositAmount / 100).toLocaleString();
    const balanceNaira = (balanceAmount / 100).toLocaleString();

    void this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `🚗 *Operator assigned!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⚠️ *ACTION NEEDED* — tap the link below to pay and confirm. You have *30 minutes*:\n\n👉 ${checkoutUrl}\n\nReply CANCEL to cancel (no charge).`,
    );
    void this.twilioService.sendWhatsAppMessage(
      operatorPhone,
      `🚗 You've been assigned a job (₦${(dto.priceKobo / 100).toLocaleString()}). Waiting for the customer to confirm payment.`,
    );

    return { data: this.mapToDetailDto(updated, true) };
  }

  /**
   * Admin-triggered refund for a deposit that arrived after its request was
   * already CANCELLED (see PaymentEventsService.handleLateDeposit). Always
   * refunds the full deposit amount — no partial-amount input.
   *
   * ELIGIBLE and FAILED are both claimable (a FAILED attempt must stay
   * retryable, same shape as PayoutService.retryPayout). NONE is deliberately
   * not claimable — a request that was never marked ELIGIBLE is not this
   * feature's concern, even if it's CANCELLED with a paid deposit for some
   * other reason.
   */
  async refundDeposit(id: string): Promise<void> {
    const request = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        payments: { select: { id: true, type: true, status: true } },
      },
    });
    if (!request) throw new NotFoundException('Rescue request not found');

    // Eligibility is now derived, not a separately claimed flag — see
    // domain/derive-payment-state.ts. ELIGIBLE and FAILED are both claimable
    // (a FAILED attempt must stay retryable, same shape as
    // PayoutService.retryPayout); NONE is deliberately not claimable — a
    // request that was never late-paid after cancellation is not this
    // feature's concern, even if it's CANCELLED with a paid deposit for some
    // other reason; PENDING/COMPLETED are already in progress or done.
    //
    // This read is a courtesy check, not the safety guarantee — two admins
    // clicking Refund simultaneously both pass it. The actual guard is the
    // in-flight partial unique index below, on paymentLedger.create().
    const refundStatus = deriveRefundStatus(request.status, request.payments);
    if (refundStatus !== 'ELIGIBLE' && refundStatus !== 'FAILED') {
      throw new BadRequestException(
        'Not eligible for refund — already refunded/in progress, or not a late-payment case.',
      );
    }
    if (!request.depositAmount) {
      throw new BadRequestException(
        `Cannot refund request ${id}: missing depositAmount`,
      );
    }
    // Guaranteed to exist: both ELIGIBLE and FAILED require a succeeded
    // deposit — see deriveRefundStatus.
    const depositPayment = request.payments.find(
      (p) =>
        p.type === PaymentType.DEPOSIT && p.status === PaymentStatus.SUCCEEDED,
    )!;

    let payment: Payment;
    try {
      payment = await this.paymentLedger.create({
        rescueRequestId: id,
        type: 'REFUND',
        amount: request.depositAmount,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(
          'A refund is already in progress for this request',
        );
      }
      throw error;
    }

    if (
      !(await this.paymentLedger.claimForSubmission(payment.id, new Date()))
    ) {
      throw new BadRequestException(
        'A refund is already in progress for this request',
      );
    }

    const result = await this.paystackService.refundTransaction({
      // The deposit's OWN reference — the original transaction to refund.
      transaction: this.paymentLedger.referenceFor(depositPayment),
      amount: request.depositAmount,
      // The BARE id, not the formatted reference — refunds have no reference,
      // and this note is what recovery matches on.
      merchantNote: payment.id,
    });

    if (result.outcome === 'ambiguous') {
      // Nothing to release: eligibility is derived from this Payment row's
      // own status, and a SUBMITTED row already reads as not-retryable.
      // Verification adopts whatever landed; a second POST would refund twice.
      throw new BadRequestException(
        `Refund status unknown — it is being verified. Do not retry yet.`,
      );
    }
    if (result.outcome === 'rejected') {
      const failureReason = result.message ?? 'refund rejected';
      await this.paymentLedger.recordRejection(payment.id, failureReason);
      throw new BadRequestException(`Refund failed: ${failureReason}`);
    }

    // providerRef first: it is how the refund webhook will find this row,
    // since refunds carry no reference of ours. There is no separate
    // "depositRefundId" column any more — this providerRef IS the refund's
    // recorded identity now.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: `refund:${result.data.id}` },
    });

    // As with transfers, the POST may not produce SUCCEEDED — `processed`
    // included. Only BLOCKED and a definitive failure may come from here.
    const mapped = mapRefundStatus(result.data.status);
    if (mapped.status === PaymentStatus.BLOCKED) {
      // Paystack has the refund and is waiting on customer details. It
      // exists, so this must not become retryable.
      await this.paymentLedger.recordBlocked(payment.id, mapped.blockReason!);
    } else if (mapped.status === PaymentStatus.FAILED) {
      await this.paymentLedger.claimTerminal(payment.id, mapped);
    }
    // Everything else — including `processed` — stays SUBMITTED.
  }

  /**
   * Read-only lookup for the caller's own audit-log entry — kept separate
   * from `refundDeposit`'s return value (`void`) rather than widening it, so
   * the many existing `resolves.toBeUndefined()` assertions on that method
   * stay valid.
   */
  async getDepositAmount(id: string): Promise<number | null> {
    const request = await this.prisma.rescueRequest.findUnique({
      where: { id },
      select: { depositAmount: true },
    });
    return request?.depositAmount ?? null;
  }

  async updateStatus(id: string, dto: { status: string }) {
    const status = dto.status as RescueRequestStatus;
    if (!Object.values(RescueRequestStatus).includes(status)) {
      throw new BadRequestException(`Invalid status: ${dto.status}`);
    }
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data: { status },
      include: {
        customer: true,
        payments: { select: { id: true, type: true, status: true } },
      },
    });

    if (
      status === RescueRequestStatus.COMPLETED ||
      status === RescueRequestStatus.CANCELLED
    ) {
      await this.sharedService.endRelayForEndedRequest(id);
    }

    if (status === RescueRequestStatus.COMPLETED) {
      await this.paymentEventsService.markJobCompleted(id);
    } else if (status === RescueRequestStatus.CANCELLED) {
      // Same reasoning as cancel() below — this is a separate admin path
      // to CANCELLED and must close out leftover PENDING offers the same
      // way, or other operators keep seeing this job as open.
      await this.prisma.dispatchOffer.updateMany({
        where: { rescueRequestId: id, status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      // Also close out any already-QUOTED offer — see the identical comment
      // in cancel() below for why leaving it QUOTED is unsafe.
      await this.prisma.dispatchOffer.updateMany({
        where: { rescueRequestId: id, status: 'QUOTED' },
        data: { status: 'NOT_SELECTED', respondedAt: new Date() },
      });
    }
    return { data: this.mapToDetailDto(updated, true) };
  }

  async cancel(id: string, dto: { reason?: string }) {
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data: { status: RescueRequestStatus.CANCELLED },
      include: {
        customer: true,
        payments: { select: { id: true, type: true, status: true } },
      },
    });

    // Any operator still holding a PENDING offer on this job (other than
    // whoever was assigned, if anyone) must have it closed out here — this
    // update is the only place that marks the request CANCELLED for these
    // rows, since closeBidding only fires from the normal bidding-timeout
    // path. Left PENDING, those operators keep seeing a cancelled job as
    // "open" (counted in "you have N jobs open at once", quotable, etc.)
    // until each offer's own expiresAt eventually passes on its own.
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId: id, status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });
    // Also close out any already-QUOTED offer — left QUOTED, it outlives
    // this cancellation and deliverQuoteShortlist would otherwise still
    // find it on a later reconciler tick and send the customer a "pick a
    // quote" message for a request they just cancelled.
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId: id, status: 'QUOTED' },
      data: { status: 'NOT_SELECTED', respondedAt: new Date() },
    });

    // An open chat relay outlives session state and would leave both
    // parties relaying into this now-dead job forever.
    await this.sharedService.endRelayForEndedRequest(id);

    // The customer's WhatsApp session may still be mid-flow (e.g. sitting
    // in AWAITING_COMPLETION_CONFIRM) and pointed at this now-dead request.
    // Without clearing it, telling them "send SOS" below is actively
    // misleading — SOS would hit the stale state first and just re-send
    // whatever reminder that state was showing, forever. The customer's
    // own CANCEL command already does this; the admin action was missing it.
    await this.sessionStore.clear(updated.customerId);

    if (updated.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        updated.customer.phoneNumber,
        `❌ Your rescue request has been cancelled${dto.reason ? `: ${dto.reason}` : '.'}\n\nSend SOS or HELP if you need assistance again.`,
      );
    }
    return { data: this.mapToDetailDto(updated, true) };
  }

  async operatorList(userId: string, query: any) {
    const operatorIds =
      await this.operatorMembershipService.findActiveOperatorIdsForUser(userId);
    if (operatorIds.length === 0)
      return { data: [], meta: { page: 1, limit: 20, total: 0 } };

    const where: any = { assignedOperatorId: { in: operatorIds } };
    const { status, page = 1, limit = 20 } = query;
    if (status) where.status = status;

    return this.buildListResponse(where, Number(page), Number(limit));
  }

  async operatorDetail(userId: string, id: string) {
    const operatorIds =
      await this.operatorMembershipService.findActiveOperatorIdsForUser(userId);

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, phoneNumber: true, email: true, name: true },
        },
        assignedOperator: {
          select: {
            id: true,
            businessName: true,
            phoneNumber: true,
            email: true,
          },
        },
        payments: { select: { id: true, type: true, status: true } },
      },
    });

    if (!raw || !operatorIds.includes(raw.assignedOperatorId!)) {
      throw new UnauthorizedException(
        'Rescue request not found or access denied',
      );
    }
    return { data: this.mapToDetailDto(raw, false) };
  }

  async listForUser(user: any, query: any) {
    const { role } = user;
    const {
      status,
      issueType,
      operatorId,
      depositPaid,
      balancePaid,
      from,
      to,
      search,
      page = 1,
      limit = 20,
    } = query;

    const whereClause: any = {};
    if (status) whereClause.status = status;
    if (issueType) whereClause.issueType = issueType;

    const paymentFilters = this.buildPaymentFilters({
      depositPaid,
      balancePaid,
    });
    if (paymentFilters.length > 0) whereClause.AND = paymentFilters;

    if (from && to)
      whereClause.createdAt = { gte: new Date(from), lte: new Date(to) };
    else if (from) whereClause.createdAt = { gte: new Date(from) };
    else if (to) whereClause.createdAt = { lte: new Date(to) };
    if (search) {
      whereClause.OR = [
        {
          customer: { phoneNumber: { contains: search, mode: 'insensitive' } },
        },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
        {
          assignedOperator: {
            businessName: { contains: search, mode: 'insensitive' },
          },
        },
      ];
    }

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      if (operatorId) whereClause.assignedOperatorId = operatorId;
      return this.buildListResponse(
        whereClause,
        parseInt(page),
        parseInt(limit),
      );
    }

    if (role === 'OPERATOR') {
      const operatorIds =
        await this.operatorMembershipService.findActiveOperatorIdsForUser(
          user.userId,
        );
      if (operatorIds.length === 0)
        return { data: [], meta: { page: 1, limit, total: 0 } };
      whereClause.assignedOperatorId = { in: operatorIds };
      return this.buildListResponse(
        whereClause,
        parseInt(page),
        parseInt(limit),
      );
    }

    // CUSTOMER — only see their own requests
    if (role === 'CUSTOMER') {
      whereClause.customerId = user.userId;
      return this.buildListResponse(
        whereClause,
        parseInt(page),
        parseInt(limit),
      );
    }

    throw new UnauthorizedException('Access denied');
  }

  async detailForUser(
    user: any,
    id: string,
  ): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, phoneNumber: true, email: true, name: true },
        },
        assignedOperator: {
          select: {
            id: true,
            businessName: true,
            phoneNumber: true,
            email: true,
          },
        },
        media: {
          select: {
            id: true,
            mediaType: true,
            context: true,
            uploadedByRole: true,
            createdAt: true,
          },
        },
        dispatchOffers: {
          include: { operator: { select: { id: true, businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
        ratings: true,
        payments: { select: { id: true, type: true, status: true } },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      const config = await this.platformConfigService.getConfig();
      const offers: DispatchOfferAdminDto[] = raw.dispatchOffers.map(
        (o: any) => ({
          operatorId: o.operatorId,
          businessName: o.operator.businessName,
          status: o.status,
          quotedPrice: o.quotedPrice ?? undefined,
          motoristFacingTotal: o.quotedPrice
            ? o.quotedPrice +
              Math.round((o.quotedPrice * config.serviceFeePercent) / 100)
            : undefined,
          offeredAt: o.offeredAt,
          respondedAt: o.respondedAt ?? undefined,
        }),
      );
      return { data: this.mapToDetailDto(raw, true, offers) };
    }

    if (role === 'OPERATOR') {
      const operatorIds =
        await this.operatorMembershipService.findActiveOperatorIdsForUser(
          userId,
        );
      if (!operatorIds.includes(raw.assignedOperatorId!)) {
        throw new UnauthorizedException(
          'You do not have access to this rescue request',
        );
      }
      return { data: this.mapToDetailDto(raw, false) };
    }

    if (role === 'CUSTOMER') {
      if (raw.customerId !== userId) {
        throw new UnauthorizedException(
          'You do not have access to this rescue request',
        );
      }
      return { data: this.mapToDetailDto(raw, false) };
    }

    throw new UnauthorizedException('Access denied');
  }

  private async buildListResponse(
    where: any,
    page: number,
    limit: number,
  ): Promise<RescueRequestListResponseDto> {
    const skip = (page - 1) * limit;
    const [rawData, total] = await Promise.all([
      this.prisma.rescueRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, phoneNumber: true } },
          assignedOperator: { select: { id: true, businessName: true } },
          payments: { select: { id: true, type: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.rescueRequest.count({ where }),
    ]);

    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id: item.id,
      status: item.status,
      issueType: item.issueType ?? undefined,
      latitude: item.latitude ? Number(item.latitude) : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: hasSucceededPayment(item.payments, PaymentType.DEPOSIT),
      balancePaid: hasSucceededPayment(item.payments, PaymentType.BALANCE),
      depositRefundStatus: deriveRefundStatus(item.status, item.payments),
      customer: {
        id: item.customer.id,
        phoneNumber: item.customer.phoneNumber!,
      },
      assignedOperator: item.assignedOperator
        ? {
            id: item.assignedOperator.id,
            businessName: item.assignedOperator.businessName,
          }
        : undefined,
      disputed: item.disputed,
      disputeRaisedAt: item.disputeRaisedAt ?? undefined,
      disputeResolvedAt: item.disputeResolvedAt ?? undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    const meta: PaginationMetaDto = { page, limit, total };
    return { data, meta };
  }

  private mapToDetailDto(
    raw: any,
    includeAllMedia: boolean,
    offers?: DispatchOfferAdminDto[],
  ): RescueRequestDetailDto {
    const apiBaseUrl = process.env.API_BASE_URL;
    const allMedia = (raw.media ?? []) as {
      id: string;
      mediaType: string;
      context: string;
      uploadedByRole: string;
      createdAt: Date;
    }[];
    const initialMedia = allMedia.filter((m) => m.context === 'INITIAL');
    const mediaLinks: string[] = apiBaseUrl
      ? initialMedia.map((m) => `${apiBaseUrl}/api/v1/media/${m.id}`)
      : [];
    const media: RequestMediaDto[] | undefined =
      includeAllMedia && apiBaseUrl
        ? allMedia.map((m) => ({
            id: m.id,
            url: `${apiBaseUrl}/api/v1/media/${m.id}`,
            mediaType: m.mediaType as RequestMediaDto['mediaType'],
            context: m.context as RequestMediaDto['context'],
            uploadedByRole:
              m.uploadedByRole as RequestMediaDto['uploadedByRole'],
            createdAt: m.createdAt,
          }))
        : undefined;

    return {
      id: raw.id,
      status: raw.status,
      issueType: raw.issueType ?? undefined,
      vehicleType: raw.vehicleType ?? undefined,
      destination: raw.destination ?? undefined,
      mediaLinks,
      media,
      latitude: raw.latitude ? Number(raw.latitude) : undefined,
      longitude: raw.longitude ? Number(raw.longitude) : undefined,
      depositPaid: hasSucceededPayment(raw.payments, PaymentType.DEPOSIT),
      depositAmount: raw.depositAmount,
      depositReference: this.latestPaymentReference(
        raw.payments,
        PaymentType.DEPOSIT,
      ),
      balancePaid: hasSucceededPayment(raw.payments, PaymentType.BALANCE),
      balanceAmount: raw.balanceAmount,
      balanceReference: this.latestPaymentReference(
        raw.payments,
        PaymentType.BALANCE,
      ),
      customer: {
        id: raw.customer.id,
        phoneNumber: raw.customer.phoneNumber,
        email: raw.customer.email,
        name: raw.customer.name,
      },
      assignedOperator: raw.assignedOperator
        ? {
            id: raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber: raw.assignedOperator.phoneNumber,
            email: raw.assignedOperator.email,
          }
        : undefined,
      disputed: raw.disputed,
      disputeRaisedAt: raw.disputeRaisedAt ?? undefined,
      disputeResolvedAt: raw.disputeResolvedAt ?? undefined,
      customerDisputeStatement: raw.customerDisputeStatement ?? undefined,
      operatorDisputeStatement: raw.operatorDisputeStatement ?? undefined,
      disputeResolutionNote: raw.disputeResolutionNote ?? undefined,
      disputeOriginalBalanceAmount:
        raw.disputeOriginalBalanceAmount ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      offers,
      ratings: (raw.ratings ?? []).map((r: any) => ({
        id: r.id,
        direction: r.direction,
        score: r.score,
        comment: r.comment ?? undefined,
        flagged: r.flagged,
        flaggedAt: r.flaggedAt ?? undefined,
        flaggedResolvedAt: r.flaggedResolvedAt ?? undefined,
      })),
    };
  }

  /**
   * The reference field this DTO exposes is now derived, not stored: the
   * SUCCEEDED attempt if one exists, else whichever attempt is most recent
   * (a request mid-flow, or one whose only attempts failed). Undefined when
   * no payment of that type was ever created.
   */
  private latestPaymentReference(
    payments: Pick<Payment, 'id' | 'type' | 'status' | 'createdAt'>[],
    type: PaymentType,
  ): string | undefined {
    const candidates = payments.filter((p) => p.type === type);
    if (candidates.length === 0) return undefined;
    const chosen =
      candidates.find((p) => p.status === PaymentStatus.SUCCEEDED) ??
      candidates.reduce((latest, p) =>
        p.createdAt > latest.createdAt ? p : latest,
      );
    return this.paymentLedger.referenceFor(chosen);
  }

  /**
   * depositPaid/balancePaid as Prisma relation-filter fragments, one entry
   * per filter actually supplied. Kept as a list rather than assigned onto
   * one `where.payments` key, since adminList can ALSO need a THIRD
   * payments-relation condition (refundEligible) — a single key would let
   * the later assignment silently overwrite the earlier one.
   */
  private buildPaymentFilters(query: {
    depositPaid?: unknown;
    balancePaid?: unknown;
  }): Array<{ payments: unknown }> {
    const filters: Array<{ payments: unknown }> = [];
    const succeededFilter = (type: PaymentType, want: boolean) =>
      want
        ? { some: { type, status: PaymentStatus.SUCCEEDED } }
        : { none: { type, status: PaymentStatus.SUCCEEDED } };

    if (query.depositPaid !== undefined) {
      const want = query.depositPaid === 'true' || query.depositPaid === true;
      filters.push({
        payments: succeededFilter(PaymentType.DEPOSIT, want),
      });
    }
    if (query.balancePaid !== undefined) {
      const want = query.balancePaid === 'true' || query.balancePaid === true;
      filters.push({
        payments: succeededFilter(PaymentType.BALANCE, want),
      });
    }
    return filters;
  }
}
