import { Injectable, UnauthorizedException } from '@nestjs/common';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import {
  IssueType,
  WhatsAppFlowState,
} from './state/whatsapp-session.types';
import { PrismaService } from '../prisma/prisma.service';
import { RescueRequestStatus, UserRole } from '@prisma/client';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import {
  RescueRequestListResponseDto,
  RescueRequestListItemDto,
  RescueRequestDetailResponseDto,
  RescueRequestDetailDto,
  PaginationMetaDto,
} from './dto/rescue-request-response.dto';

const DEPOSIT_AMOUNT_KOBO = 500000; // ₦5,000 deposit

@Injectable()
export class RescueRequestService {
  constructor(
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
  ) {}

  // Unified API for rescue requests by user role
  async listForUser(user: any, query: any) {
    const { role } = user;
    const { status, issueType, operatorId, depositPaid, balancePaid, from, to, search, page = 1, limit = 20 } = query;

    // Build dynamic where clause
    const whereClause: any = {};

    // Apply filters
    if (status) {
      whereClause.status = status;
    }
    if (issueType) {
      whereClause.issueType = issueType;
    }
    if (depositPaid !== undefined) {
      whereClause.depositPaid = depositPaid === 'true' || depositPaid === true;
    }
    if (balancePaid !== undefined) {
      whereClause.balancePaid = balancePaid === 'true' || balancePaid === true;
    }
    if (from && to) {
      whereClause.createdAt = {
        gte: new Date(from),
        lte: new Date(to),
      };
    } else if (from) {
      whereClause.createdAt = { gte: new Date(from) };
    } else if (to) {
      whereClause.createdAt = { lte: new Date(to) };
    }
    if (search) {
      whereClause.OR = [
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
        { assignedOperator: { businessName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // SUPER_ADMIN and ADMIN: return all rescue requests with filters
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      if (operatorId) {
        whereClause.assignedOperatorId = operatorId;
      }
      return this.buildListResponse(
        whereClause,
        parseInt(page) || 1,
        parseInt(limit) || 20,
      );
    }

    // OPERATOR: return only requests assigned to their operator(s)
    if (role === 'OPERATOR') {
      const operatorMemberships = await this.prisma.operatorMember.findMany({
        where: { userId: user.userId },
        select: { operatorId: true },
      });

      const operatorIds = operatorMemberships.map((m) => m.operatorId);

      if (operatorIds.length === 0) {
        return { data: [], meta: { page: 1, limit, total: 0 } };
      }

      whereClause.assignedOperatorId = { in: operatorIds };

      return this.buildListResponse(
        whereClause,
        parseInt(page) || 1,
        parseInt(limit) || 20,
      );
    }

    // CUSTOMER: reject for now (can be implemented later to return own requests)
    throw new UnauthorizedException('Customers do not have access to rescue request list');
  }

  private async buildListResponse(where: any, page: number, limit: number): Promise<RescueRequestListResponseDto> {
    const skip = (page - 1) * limit;

    const [rawData, total] = await Promise.all([
      this.prisma.rescueRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, phoneNumber: true } },
          assignedOperator: { select: { id: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.rescueRequest.count({ where }),
    ]);

    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id: item.id,
      status: item.status,
      issueType: item.issueType || undefined,
      latitude: item.latitude ? Number(item.latitude) : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: item.depositPaid,
      balancePaid: item.balancePaid,
      customer: {
        id: item.customer.id,
        phoneNumber: item.customer.phoneNumber!,
      },
      assignedOperator: item.assignedOperator
        ? { id: item.assignedOperator.id, businessName: item.assignedOperator.businessName }
        : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    const meta: PaginationMetaDto = { page, limit, total };

    return { data, meta };
  }

  async detailForUser(user: any, id: string): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    // Fetch the rescue request
    const rawRescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
      },
    });

    if (!rawRescueRequest) {
      throw new UnauthorizedException('Rescue request not found');
    }

    // SUPER_ADMIN and ADMIN: return full detail
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      return { data: this.mapToDetailDto(rawRescueRequest) };
    }

    // OPERATOR: return only if assigned to their operator(s)
    if (role === 'OPERATOR') {
      const operatorMemberships = await this.prisma.operatorMember.findMany({
        where: { userId },
        select: { operatorId: true },
      });

      const operatorIds = operatorMemberships.map((m) => m.operatorId);

      if (!operatorIds.includes(rawRescueRequest.assignedOperatorId!)) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }

      return { data: this.mapToDetailDto(rawRescueRequest) };
    }

    // CUSTOMER: reject for now (can be implemented later to return own requests)
    throw new UnauthorizedException('Customers do not have access to rescue request details');
  }

  private mapToDetailDto(rawRescueRequest: any): RescueRequestDetailDto {
    return {
      id: rawRescueRequest.id,
      status: rawRescueRequest.status,
      issueType: rawRescueRequest.issueType || undefined,
      latitude: rawRescueRequest.latitude ? Number(rawRescueRequest.latitude) : undefined,
      longitude: rawRescueRequest.longitude ? Number(rawRescueRequest.longitude) : undefined,
      depositPaid: rawRescueRequest.depositPaid,
      depositAmount: rawRescueRequest.depositAmount,
      depositReference: rawRescueRequest.depositReference,
      balancePaid: rawRescueRequest.balancePaid,
      balanceAmount: rawRescueRequest.balanceAmount,
      balanceReference: rawRescueRequest.balanceReference,
      customer: {
        id: rawRescueRequest.customer.id,
        phoneNumber: rawRescueRequest.customer.phoneNumber,
        email: rawRescueRequest.customer.email,
        name: rawRescueRequest.customer.name,
      },
      assignedOperator: rawRescueRequest.assignedOperator
        ? {
            id: rawRescueRequest.assignedOperator.id,
            businessName: rawRescueRequest.assignedOperator.businessName,
            phoneNumber: rawRescueRequest.assignedOperator.phoneNumber,
            email: rawRescueRequest.assignedOperator.email,
          }
        : undefined,
      createdAt: rawRescueRequest.createdAt,
      updatedAt: rawRescueRequest.updatedAt,
    };
  }

  // ...existing methods...

  // ================= ADMIN API =================
  async adminList(query: any) {
    // TODO: Implement filtering, pagination, and search
    return { data: [], meta: { page: 1, limit: 20, total: 0 } };
  }

  async adminDetail(id: string) {
    // TODO: Implement detail fetch
    return {};
  }

  async assignOperator(id: string, dto: { operatorId: string }) {
    // TODO: Implement operator assignment
    return {};
  }

  async updateStatus(id: string, dto: { status: string }) {
    // TODO: Implement status update
    return {};
  }

  async cancel(id: string, dto: { reason: string }) {
    // TODO: Implement cancel logic
    return {};
  }

  // ================= OPERATOR API =================
  async operatorList(query: any) {
    // TODO: Implement operator filtering
    return { data: [], meta: { page: 1, limit: 20, total: 0 } };
  }

  async operatorDetail(id: string) {
    // TODO: Implement operator detail fetch
    return {};
  }


  /**
   * Find or create a customer user by phone number
   */
  private async findOrCreateCustomer(phoneNumber: string) {
    let customer = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!customer) {
      customer = await this.prisma.user.create({
        data: {
          phoneNumber,
          role: UserRole.CUSTOMER,
        },
      });
      console.log('New customer created:', customer.id);
    }

    return customer;
  }

  async handleIncomingWhatsAppMessage(body: Record<string, any>) {
    const phoneNumber = body.From;
    const message = String(body.Body || '').trim().toLowerCase();
    const latitude = body.Latitude ? Number(body.Latitude) : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;

    console.log('Incoming WhatsApp message:', {
      phoneNumber,
      message,
      latitude,
      longitude,
    });

    const session = this.sessionStore.getOrCreate(phoneNumber);

    // Handle SOS/HELP to start a new request
    if (this.isSosMessage(message)) {
      this.sessionStore.update(phoneNumber, {
        state: WhatsAppFlowState.WAITING_FOR_LOCATION,
      });
      return this.reply(
        `LRR Rescue here. Please share your current location pin so we can find the nearest tow operator.`,
      );
    }

    // Step 1: Waiting for location
    if (session.state === WhatsAppFlowState.WAITING_FOR_LOCATION) {
      if (!latitude || !longitude) {
        return this.reply(
          `Please share your location using WhatsApp location pin, not typed address.`,
        );
      }
      this.sessionStore.update(phoneNumber, {
        latitude,
        longitude,
        state: WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE,
      });
      return this.reply(
        `Location received. What issue are you having?\n\n1. Breakdown\n2. Accident\n3. Flat tyre\n4. Fuel`,
      );
    }

    // Step 2: Waiting for issue type
    if (session.state === WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE) {
      const issueType = this.mapIssueType(message);
      if (!issueType) {
        return this.reply(
          `Please reply with a number (1-4) to select the issue type.`,
        );
      }

      // Find or create customer
      const customer = await this.findOrCreateCustomer(phoneNumber);

      // Create rescue request in DB with WAITING_FOR_DEPOSIT status
      const rescueRequest = await this.prisma.rescueRequest.create({
        data: {
          customerId: customer.id,
          status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
          latitude: session.latitude,
          longitude: session.longitude,
          issueType,
          depositAmount: DEPOSIT_AMOUNT_KOBO,
        },
      });

      console.log('RescueRequest created:', rescueRequest);

      // Generate Paystack payment link
      const reference = this.paystackService.generateReference('DEP');
      const email = customer.email || `${phoneNumber.replace(/[^0-9]/g, '')}@lrr.ng`;

      const paymentResponse = await this.paystackService.initializePayment({
        email,
        amount: DEPOSIT_AMOUNT_KOBO,
        reference,
        metadata: {
          rescueRequestId: rescueRequest.id,
          customerId: customer.id,
          phoneNumber,
          type: 'deposit',
        },
      });

      if (!paymentResponse.status) {
        console.error('Failed to initialize payment:', paymentResponse);
        return this.reply(
          `Sorry, we couldn't create a payment link. Please try again later.`,
        );
      }

      // Update rescue request with payment reference
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequest.id },
        data: { depositReference: reference },
      });

      // Update session
      this.sessionStore.update(phoneNumber, {
        issueType,
        rescueRequestId: rescueRequest.id,
        depositReference: reference,
        state: WhatsAppFlowState.WAITING_FOR_DEPOSIT,
      });

      const paymentUrl = paymentResponse.data.authorization_url;

      return this.reply(
        `Issue: ${this.formatIssueType(issueType)}\n\nTo confirm your request, please pay a ₦5,000 deposit.\n\nPay here: ${paymentUrl}\n\nOnce payment is confirmed, we will dispatch a tow operator to your location.`,
      );
    }

    // Step 3: Waiting for deposit confirmation
    if (session.state === WhatsAppFlowState.WAITING_FOR_DEPOSIT) {
      return this.reply(
        `We're still waiting for your deposit payment.\n\nOnce payment is confirmed, we will dispatch a tow operator to your location.\n\nIf you've already paid, please wait a moment for confirmation.`,
      );
    }

    // Step 4: Request confirmed
    if (session.state === WhatsAppFlowState.REQUEST_CONFIRMED) {
      return this.reply(
        `Your rescue request is confirmed and a tow operator is being dispatched.\n\nSend HELP or SOS to start a new request.`,
      );
    }

    return this.reply(
      `Welcome to Lagos Roadside Rescue.\n\nSend HELP or SOS if you need roadside assistance.`,
    );
  }

  /**
   * Handle deposit payment confirmation (called from webhook)
   */
  async handleDepositPaymentConfirmed(reference: string) {
    const rescueRequest = await this.prisma.rescueRequest.findFirst({
      where: { depositReference: reference },
      include: { customer: true },
    });

    if (!rescueRequest) {
      console.error('No rescue request found for reference:', reference);
      return;
    }

    const customerPhoneNumber = rescueRequest.customer.phoneNumber;

    // Update rescue request to DISPATCHING
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data: {
        depositPaid: true,
        status: RescueRequestStatus.DISPATCHING,
      },
    });

    // Update session state
    if (customerPhoneNumber) {
      this.sessionStore.update(customerPhoneNumber, {
        state: WhatsAppFlowState.REQUEST_CONFIRMED,
      });
    }

    console.log('Deposit confirmed for rescue request:', rescueRequest.id);

    const issueType = rescueRequest.issueType
      ? this.formatIssueType(rescueRequest.issueType)
      : 'Unknown';

    // Send payment confirmation to customer
    if (customerPhoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhoneNumber,
        `✅ Payment received!\n\nYour ₦5,000 deposit has been confirmed.\n\nIssue: ${issueType}\n\nWe are now finding the nearest tow operator...`,
      );
    }

    // Find nearest available operator
    const latitude = Number(rescueRequest.latitude);
    const longitude = Number(rescueRequest.longitude);
    const nearestOperator = await this.operatorService.findNearestAvailable(latitude, longitude);

    if (!nearestOperator) {
      console.log('No available operators found for rescue request:', rescueRequest.id);
      
      // Update request to indicate waiting for operator
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequest.id },
        data: { status: RescueRequestStatus.DISPATCHING }, // Keep in DISPATCHING while searching
      });

      if (customerPhoneNumber) {
        await this.twilioService.sendWhatsAppMessage(
          customerPhoneNumber,
          `⏳ We're searching for available tow operators in your area...\n\nThis may take a few moments. We'll notify you as soon as one is assigned.\n\nThank you for your patience.`,
        );
      }
      
      // TODO: Implement queue system or scheduled retry for operator assignment
      console.warn(`Request ${rescueRequest.id} queued for operator assignment`);
      return;
    }

    // Assign operator to rescue request
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data: {
        assignedOperatorId: nearestOperator.id,
        status: RescueRequestStatus.OPERATOR_ASSIGNED,
      },
    });

    console.log(`Operator ${nearestOperator.businessName} assigned to rescue request ${rescueRequest.id}`);

    // Notify operator via WhatsApp
    await this.twilioService.sendWhatsAppMessage(
      `whatsapp:${nearestOperator.phoneNumber}`,
      `🚨 NEW RESCUE REQUEST\n\nIssue: ${issueType}\nDistance: ${nearestOperator.distance.toFixed(1)} km\n\nCustomer is waiting for your assistance.\n\nPlease respond ASAP.`,
    );

    // Notify customer that operator is assigned
    if (customerPhoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhoneNumber,
        `🚗 Tow operator assigned!\n\nBusiness: ${nearestOperator.businessName}\nDistance: ${nearestOperator.distance.toFixed(1)} km away\n\nThey have been notified and will contact you shortly.`,
      );
    }
  }

  private isSosMessage(message: string): boolean {
    return ['help', 'sos', 'stuck', 'rescue'].some((word) =>
      message.includes(word),
    );
  }

  private mapIssueType(message: string): IssueType | undefined {
    switch (message) {
      case '1':
        return 'BREAKDOWN';
      case '2':
        return 'ACCIDENT';
      case '3':
        return 'FLAT_TYRE';
      case '4':
        return 'FUEL';
      default:
        return undefined;
    }
  }

  private formatIssueType(issueType: IssueType): string {
    return issueType
      .replace('_', ' ')
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private reply(message: string) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>${message}</Message>\n</Response>`;
  }
}
