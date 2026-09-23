import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Payment, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorMembershipService } from '../operator/operator-membership.service';
import {
  PaymentListItemDto,
  PaymentListQueryDto,
  PaymentListResponseDto,
  PaymentSummaryDto,
} from './dto/payment-list.dto';

const STAFF_ROLES: string[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.PRODUCT,
];

// Only these two types are customer-paid collections — REFUND/PAYOUT rows
// still show up in the raw list, they just don't belong in a "collected vs
// outstanding" summary built for the customer side of the ledger.
const COLLECTION_TYPES = new Set(['DEPOSIT', 'BALANCE']);
const IN_FLIGHT_STATUSES = new Set(['PENDING', 'SUBMITTED', 'BLOCKED']);

type PaymentWithRelations = Payment & {
  rescueRequest: {
    customer: { id: string; phoneNumber: string | null };
    assignedOperator: { id: string; businessName: string } | null;
  };
  operator: { id: string; businessName: string } | null;
};

const EMPTY_SUMMARY: PaymentSummaryDto = {
  depositCollected: 0,
  balanceCollected: 0,
  totalCollected: 0,
  depositPending: 0,
  balancePending: 0,
  totalOutstanding: 0,
};

/**
 * Real payment-ledger reads for the admin/operator "Payments" view — the
 * counterpart to RescueRequestAdminService.listForUser, but over the actual
 * Payment table instead of a derived (depositPaid/balancePaid) view of
 * RescueRequest. See docs/superpowers/specs/2026-09-12-payment-model-design.md
 * for why one row is one attempt, never reused.
 */
@Injectable()
export class PaymentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorMembershipService: OperatorMembershipService,
  ) {}

  async listForUser(
    user: { userId: string; role: string },
    query: PaymentListQueryDto,
  ): Promise<PaymentListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = await this.buildWhere(user, query);
    if (where === null) return { data: [], meta: { page: 1, limit, total: 0 } };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          rescueRequest: {
            select: {
              customer: { select: { id: true, phoneNumber: true } },
              assignedOperator: { select: { id: true, businessName: true } },
            },
          },
          operator: { select: { id: true, businessName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: (rows as PaymentWithRelations[]).map((row) => this.toDto(row)),
      meta: { page, limit, total },
    };
  }

  async summaryForUser(
    user: { userId: string; role: string },
    query: PaymentListQueryDto,
  ): Promise<PaymentSummaryDto> {
    const where = await this.buildWhere(user, query);
    if (where === null) return EMPTY_SUMMARY;

    const groups = await this.prisma.payment.groupBy({
      by: ['type', 'status'],
      where,
      _sum: { amount: true },
    });

    const summary = { ...EMPTY_SUMMARY };
    for (const group of groups) {
      if (!COLLECTION_TYPES.has(group.type)) continue;
      const amount = group._sum.amount ?? 0;
      const isDeposit = group.type === 'DEPOSIT';
      if (group.status === 'SUCCEEDED') {
        if (isDeposit) summary.depositCollected += amount;
        else summary.balanceCollected += amount;
      } else if (IN_FLIGHT_STATUSES.has(group.status)) {
        if (isDeposit) summary.depositPending += amount;
        else summary.balancePending += amount;
      }
    }
    summary.totalCollected =
      summary.depositCollected + summary.balanceCollected;
    summary.totalOutstanding = summary.depositPending + summary.balancePending;
    return summary;
  }

  /**
   * Null return is the sentinel for "role-scoped to nothing" (an operator
   * with no active membership) — distinct from `{}` (no filter at all),
   * which is what SUPER_ADMIN/ADMIN/PRODUCT get.
   */
  private async buildWhere(
    user: { userId: string; role: string },
    query: PaymentListQueryDto,
  ): Promise<Prisma.PaymentWhereInput | null> {
    const where: Prisma.PaymentWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.rescueRequestId) where.rescueRequestId = query.rescueRequestId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const { role } = user;
    if (STAFF_ROLES.includes(role)) {
      if (query.operatorId) {
        where.rescueRequest = { assignedOperatorId: query.operatorId };
      }
      return where;
    }

    if (role === UserRole.OPERATOR) {
      const operatorIds =
        await this.operatorMembershipService.findActiveOperatorIdsForUser(
          user.userId,
        );
      if (operatorIds.length === 0) return null;
      where.rescueRequest = { assignedOperatorId: { in: operatorIds } };
      return where;
    }

    throw new UnauthorizedException('Access denied');
  }

  private toDto(row: PaymentWithRelations): PaymentListItemDto {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      providerFee: row.providerFee,
      netAmount: row.netAmount,
      failureReason: row.failureReason,
      blockReason: row.blockReason,
      checkoutUrl: row.checkoutUrl,
      verifyAttempts: row.verifyAttempts,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
      rescueRequestId: row.rescueRequestId,
      customer: row.rescueRequest.customer,
      assignedOperator: row.rescueRequest.assignedOperator,
      payoutOperator: row.operator,
    };
  }
}
