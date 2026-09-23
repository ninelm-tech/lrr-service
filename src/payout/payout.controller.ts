import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutService } from './payout.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, PaymentStatus, PaymentType } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';
import { isRetryablePayoutState } from './domain/payout-retry';

/**
 * Payouts, read and retried from the Payment ledger directly (Task 11 — the
 * dedicated Payout table this used to read is gone). One row is one attempt,
 * so a request that failed once and was retried shows both rows, oldest
 * first per the usual createdAt ordering the rest of the admin UI uses.
 */
@Controller('payouts')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PayoutController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payoutService: PayoutService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  async list(@Query('status') status?: string) {
    const payments = await this.prisma.payment.findMany({
      where: {
        type: PaymentType.PAYOUT,
        ...(status ? { status: status as PaymentStatus } : {}),
      },
      include: {
        operator: { select: { businessName: true } },
        rescueRequest: {
          select: { id: true, disputed: true, disputeResolvedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Retry eligibility belongs to the payout as a whole, not an individual
    // historical attempt. Fetch all siblings for the jobs on this page so a
    // filtered view still knows which attempt is newest and whether any
    // attempt already succeeded.
    const requestIds = [...new Set(payments.map((p) => p.rescueRequestId))];
    const siblings = requestIds.length
      ? await this.prisma.payment.findMany({
          where: {
            type: PaymentType.PAYOUT,
            rescueRequestId: { in: requestIds },
          },
          select: {
            id: true,
            rescueRequestId: true,
            status: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : [];
    const succeededRequestIds = new Set(
      siblings
        .filter((p) => p.status === PaymentStatus.SUCCEEDED)
        .map((p) => p.rescueRequestId),
    );
    const latestAttemptIds = new Set<string>();
    const seenRequestIds = new Set<string>();
    for (const sibling of siblings) {
      if (!seenRequestIds.has(sibling.rescueRequestId)) {
        latestAttemptIds.add(sibling.id);
        seenRequestIds.add(sibling.rescueRequestId);
      }
    }

    const data = payments.map((p) => ({
      ...p,
      alreadySucceeded: succeededRequestIds.has(p.rescueRequestId),
      isLatestAttempt: latestAttemptIds.has(p.id),
      canRetry:
        latestAttemptIds.has(p.id) &&
        !succeededRequestIds.has(p.rescueRequestId) &&
        isRetryablePayoutState(p),
    }));
    return { data };
  }

  @Post(':id/retry')
  async retry(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const before = await this.prisma.payment.findUnique({
      where: { id },
      select: { status: true },
    });
    const payment = await this.payoutService.retryPayout(id);
    await this.auditLogService.record({
      category: 'payout_retried',
      message: `Retried payout ${id}`,
      details: {
        paymentId: id,
        resultPaymentId: payment?.id ?? null,
        before: { status: before?.status ?? null },
        after: { status: payment?.status ?? null },
      },
      actorId: req.user.userId,
    });
    return { message: describeRetryOutcome(payment), data: payment };
  }
}

/**
 * A retry can legitimately end up re-blocked — most commonly because the
 * operator still hasn't added bank details. Reporting that as "retry
 * initiated" tells the admin the opposite of what happened, so the message
 * reflects the payment's actual resulting state.
 */
function describeRetryOutcome(
  payment: {
    status: PaymentStatus;
    blockReason: string | null;
    failureReason: string | null;
  } | null,
): string {
  if (!payment)
    return 'Payout retried, but its current state could not be read.';

  switch (payment.status) {
    case PaymentStatus.SUBMITTED:
      return 'Transfer initiated — awaiting confirmation from Paystack.';
    case PaymentStatus.SUCCEEDED:
      return 'Payout completed.';
    case PaymentStatus.BLOCKED:
      if (payment.blockReason === 'NO_BANK_DETAILS') {
        return 'Still blocked — this operator has no bank details on file. Add them, then retry.';
      }
      if (payment.blockReason === 'INSUFFICIENT_BALANCE') {
        return 'Still blocked — the Paystack balance is too low to cover this payout.';
      }
      if (payment.blockReason === 'AWAITING_OTP') {
        return 'Blocked — the transfer is awaiting an OTP at Paystack.';
      }
      if (payment.blockReason === 'ACCOUNT_RESTRICTED') {
        return 'Still blocked — Paystack has not enabled third-party transfers for this business.';
      }
      if (payment.blockReason === 'PAYOUT_ON_HOLD') {
        return 'Still blocked — payouts are on hold at Paystack.';
      }
      if (payment.blockReason === 'INVALID_RECIPIENT') {
        return 'Still blocked — the Paystack transfer recipient must be corrected.';
      }
      if (payment.blockReason === 'INVALID_AMOUNT') {
        return 'Still blocked — Paystack rejected the payout amount.';
      }
      if (payment.blockReason === 'INVALID_REFERENCE') {
        return 'Still blocked — Paystack rejected the payout reference.';
      }
      if (payment.blockReason === 'PAYSTACK_VALIDATION') {
        return 'Still blocked — Paystack rejected the transfer during validation.';
      }
      return 'Still blocked.';
    case PaymentStatus.FAILED:
      return `Transfer failed${payment.failureReason ? `: ${payment.failureReason}` : '.'}`;
    case PaymentStatus.REVERSED:
      return 'Transfer was reversed.';
    case PaymentStatus.DUPLICATE_SUCCEEDED:
      return 'Duplicate provider success recorded — manual reconciliation required.';
    default:
      return 'Payout retried.';
  }
}
