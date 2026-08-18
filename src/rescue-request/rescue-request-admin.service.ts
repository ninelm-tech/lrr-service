import { BadRequestException, Injectable, NotFoundException, UnauthorizedException, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PaymentEventsService } from './payment-events.service';
import { RescueRequestStatus } from '@prisma/client';
import { toWhatsAppAddress } from '../common/phone.util';
import {
  RescueRequestListResponseDto,
  RescueRequestListItemDto,
  RescueRequestDetailResponseDto,
  RescueRequestDetailDto,
  DispatchOfferAdminDto,
  PaginationMetaDto,
} from './dto/rescue-request-response.dto';
import { DispatchService } from './dispatch.service';

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
  ) {}

  async adminList(query: any) {
    const {
      status, issueType, operatorId, depositPaid, balancePaid,
      from, to, search, page = 1, limit = 20,
    } = query;

    const where: any = {};
    if (status)     where.status    = status;
    if (issueType)  where.issueType = issueType;
    if (operatorId) where.assignedOperatorId = operatorId;
    if (depositPaid !== undefined) where.depositPaid = depositPaid === 'true' || depositPaid === true;
    if (balancePaid !== undefined) where.balancePaid = balancePaid === 'true' || balancePaid === true;
    if (from && to) where.createdAt = { gte: new Date(from), lte: new Date(to) };
    if (search) {
      where.OR = [
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { name:        { contains: search, mode: 'insensitive' } } },
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
  async assignOperator(id: string, dto: { operatorId: string; priceKobo: number }) {
    if (!dto.operatorId) throw new BadRequestException('operatorId is required');
    if (!Number.isInteger(dto.priceKobo) || dto.priceKobo <= 0) {
      throw new BadRequestException('priceKobo must be a positive integer');
    }

    const operator = await this.prisma.operator.findUnique({ where: { id: dto.operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');
    if (operator.status !== 'ACTIVE') throw new BadRequestException('Target is not an active operator');

    const request = await this.prisma.rescueRequest.findUnique({ where: { id }, include: { customer: true } });
    if (!request) throw new NotFoundException('Rescue request not found');
    if (([RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] as RescueRequestStatus[]).includes(request.status)) {
      throw new BadRequestException(`Cannot assign an operator to a ${request.status} request`);
    }
    if (!request.customer.phoneNumber) {
      throw new BadRequestException('Customer has no phone number on file — cannot send a payment link');
    }

    const config = await this.platformConfigService.getConfig();
    const serviceFeeAmount = Math.round((dto.priceKobo * config.serviceFeePercent) / 100);
    const total = dto.priceKobo + serviceFeeAmount;
    const depositAmount = Math.round((total * config.depositPercent) / 100);
    const balanceAmount = total - depositAmount;

    const MANUAL_ASSIGN_WINDOW_MS = 5 * 60 * 1000;
    const offer = await this.prisma.dispatchOffer.create({
      data: {
        rescueRequestId: id,
        operatorId:      dto.operatorId,
        status:          'SELECTED_PENDING_PAYMENT',
        quotedPrice:     dto.priceKobo,
        respondedAt:     new Date(),
        expiresAt:       new Date(Date.now() + MANUAL_ASSIGN_WINDOW_MS),
      },
    });

    const reference = this.paystackService.generateReference('DEP');
    const email = request.customer.email ?? `${request.customer.phoneNumber.replace(/\D/g, '')}@lrr.ng`;
    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: depositAmount,
      reference,
      metadata: {
        rescueRequestId: id,
        customerId:      request.customerId,
        phoneNumber:     request.customer.phoneNumber,
        type: 'deposit',
      },
    });
    if (!paymentResponse.status) {
      // Roll back the offer so a retry isn't blocked by a stale row.
      await this.prisma.dispatchOffer.delete({ where: { id: offer.id } });
      throw new BadRequestException(`Couldn't generate a payment link — please try again`);
    }

    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data: {
        assignedOperatorId: dto.operatorId,
        status:             RescueRequestStatus.WAITING_FOR_DEPOSIT,
        serviceFeeAmount,
        depositAmount,
        balanceAmount,
        depositReference:   reference,
      },
      include: { customer: true, assignedOperator: true },
    });

    const customerPhone = toWhatsAppAddress(request.customer.phoneNumber);
    const operatorPhone = toWhatsAppAddress(operator.phoneNumber);
    const depositNaira = (depositAmount / 100).toLocaleString();
    const balanceNaira = (balanceAmount / 100).toLocaleString();

    void this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `🚗 *Operator assigned!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⚠️ *ACTION NEEDED* — tap the link below to pay and confirm. You have *5 minutes*:\n\n👉 ${paymentResponse.data.authorization_url}\n\nReply CANCEL to cancel (no charge).`,
    );
    void this.twilioService.sendWhatsAppMessage(
      operatorPhone,
      `🚗 You've been assigned a job (₦${(dto.priceKobo / 100).toLocaleString()}). Waiting for the customer to confirm payment.`,
    );

    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({ where: { id }, select: { status: true } });
      if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return;

      await this.prisma.dispatchOffer.update({
        where: { id: offer.id },
        data:  { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      await this.prisma.rescueRequest.update({
        where: { id },
        data:  { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
      });
      void this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `⏰ Payment window expired. We're still looking for an operator for you.`,
      );
      void this.twilioService.sendWhatsAppMessage(
        operatorPhone,
        `⏰ The customer did not pay within 5 minutes. You have been released.`,
      );
      void this.dispatchService.startDispatch(id, request.customerId);
    }, MANUAL_ASSIGN_WINDOW_MS);

    return { data: this.mapToDetailDto(updated) };
  }

  async updateStatus(id: string, dto: { status: string }) {
    const status = dto.status as RescueRequestStatus;
    if (!Object.values(RescueRequestStatus).includes(status)) {
      throw new BadRequestException(`Invalid status: ${dto.status}`);
    }
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data:  { status },
      include: { customer: true },
    });

    if (status === RescueRequestStatus.COMPLETED) {
      await this.paymentEventsService.markJobCompleted(id);
    }
    return { data: this.mapToDetailDto(updated) };
  }

  async cancel(id: string, dto: { reason?: string }) {
    const updated = await this.prisma.rescueRequest.update({
      where: { id },
      data:  { status: RescueRequestStatus.CANCELLED },
      include: { customer: true },
    });

    if (updated.customer.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        updated.customer.phoneNumber,
        `❌ Your rescue request has been cancelled${dto.reason ? `: ${dto.reason}` : '.'}\n\nSend SOS or HELP if you need assistance again.`,
      );
    }
    return { data: this.mapToDetailDto(updated) };
  }

  async operatorList(userId: string, query: any) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    if (memberships.length === 0) return { data: [], meta: { page: 1, limit: 20, total: 0 } };

    const operatorIds = memberships.map((m) => m.operatorId);
    const where: any = { assignedOperatorId: { in: operatorIds } };
    const { status, page = 1, limit = 20 } = query;
    if (status) where.status = status;

    return this.buildListResponse(where, Number(page), Number(limit));
  }

  async operatorDetail(userId: string, id: string) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    const operatorIds = memberships.map((m) => m.operatorId);

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
      },
    });

    if (!raw || !operatorIds.includes(raw.assignedOperatorId!)) {
      throw new UnauthorizedException('Rescue request not found or access denied');
    }
    return { data: this.mapToDetailDto(raw) };
  }

  async listForUser(user: any, query: any) {
    const { role } = user;
    const { status, issueType, operatorId, depositPaid, balancePaid, from, to, search, page = 1, limit = 20 } = query;

    const whereClause: any = {};
    if (status)     whereClause.status    = status;
    if (issueType)  whereClause.issueType = issueType;
    if (depositPaid !== undefined) whereClause.depositPaid = depositPaid === 'true' || depositPaid === true;
    if (balancePaid !== undefined) whereClause.balancePaid = balancePaid === 'true' || balancePaid === true;
    if (from && to) whereClause.createdAt = { gte: new Date(from), lte: new Date(to) };
    else if (from)  whereClause.createdAt = { gte: new Date(from) };
    else if (to)    whereClause.createdAt = { lte: new Date(to) };
    if (search) {
      whereClause.OR = [
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { name:        { contains: search, mode: 'insensitive' } } },
        { assignedOperator: { businessName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      if (operatorId) whereClause.assignedOperatorId = operatorId;
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId: user.userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (operatorIds.length === 0) return { data: [], meta: { page: 1, limit, total: 0 } };
      whereClause.assignedOperatorId = { in: operatorIds };
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    // CUSTOMER — only see their own requests
    if (role === 'CUSTOMER') {
      whereClause.customerId = user.userId;
      return this.buildListResponse(whereClause, parseInt(page), parseInt(limit));
    }

    throw new UnauthorizedException('Access denied');
  }

  async detailForUser(user: any, id: string): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
        media:            { select: { id: true } },
        dispatchOffers:   {
          include: { operator: { select: { id: true, businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      const config = await this.platformConfigService.getConfig();
      const offers: DispatchOfferAdminDto[] = raw.dispatchOffers.map((o: any) => ({
        operatorId:          o.operatorId,
        businessName:        o.operator.businessName,
        status:              o.status,
        quotedPrice:         o.quotedPrice ?? undefined,
        motoristFacingTotal: o.quotedPrice
          ? o.quotedPrice + Math.round((o.quotedPrice * config.serviceFeePercent) / 100)
          : undefined,
        offeredAt:   o.offeredAt,
        respondedAt: o.respondedAt ?? undefined,
      }));
      return { data: this.mapToDetailDto(raw, offers) };
    }

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (!operatorIds.includes(raw.assignedOperatorId!)) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    if (role === 'CUSTOMER') {
      if (raw.customerId !== userId) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    throw new UnauthorizedException('Access denied');
  }

  private async buildListResponse(where: any, page: number, limit: number): Promise<RescueRequestListResponseDto> {
    const skip = (page - 1) * limit;
    const [rawData, total] = await Promise.all([
      this.prisma.rescueRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer:        { select: { id: true, phoneNumber: true } },
          assignedOperator: { select: { id: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.rescueRequest.count({ where }),
    ]);

    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id:        item.id,
      status:    item.status,
      issueType: item.issueType ?? undefined,
      latitude:  item.latitude  ? Number(item.latitude)  : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: item.depositPaid,
      balancePaid: item.balancePaid,
      customer: { id: item.customer.id, phoneNumber: item.customer.phoneNumber! },
      assignedOperator: item.assignedOperator
        ? { id: item.assignedOperator.id, businessName: item.assignedOperator.businessName }
        : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    const meta: PaginationMetaDto = { page, limit, total };
    return { data, meta };
  }

  private mapToDetailDto(raw: any, offers?: DispatchOfferAdminDto[]): RescueRequestDetailDto {
    const apiBaseUrl = process.env.API_BASE_URL;
    const mediaLinks: string[] = raw.media && apiBaseUrl
      ? raw.media.map((m: { id: string }) => `${apiBaseUrl}/api/v1/media/${m.id}`)
      : [];

    return {
      id:               raw.id,
      status:           raw.status,
      issueType:        raw.issueType    ?? undefined,
      vehicleType:      raw.vehicleType  ?? undefined,
      destination:      raw.destination  ?? undefined,
      mediaLinks,
      latitude:         raw.latitude   ? Number(raw.latitude)  : undefined,
      longitude:        raw.longitude  ? Number(raw.longitude) : undefined,
      depositPaid:      raw.depositPaid,
      depositAmount:    raw.depositAmount,
      depositReference: raw.depositReference,
      balancePaid:      raw.balancePaid,
      balanceAmount:    raw.balanceAmount,
      balanceReference: raw.balanceReference,
      customer: {
        id:          raw.customer.id,
        phoneNumber: raw.customer.phoneNumber,
        email:       raw.customer.email,
        name:        raw.customer.name,
      },
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      offers,
    };
  }
}
