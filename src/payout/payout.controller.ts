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

    // A job can have an older FAILED/BLOCKED row sitting right alongside a
    // newer SUCCEEDED sibling — a normal retry that inserted a fresh
    // attempt which later succeeded. That older row's own status says
    // nothing about whether the job is done. Computed separately, unfiltered
    // by `status`, so this holds even when the admin is viewing a
    // status-filtered list that wouldn't otherwise include the succeeded
    // sibling. Scoped to just the jobs on THIS page rather than every
    // succeeded payout ever, so the query stays bounded as the table grows.
    const requestIds = [...new Set(payments.map((p) => p.rescueRequestId))];
    const succeeded = requestIds.length
      ? await this.prisma.payment.findMany({
          where: {
            type: PaymentType.PAYOUT,
            status: PaymentStatus.SUCCEEDED,
            rescueRequestId: { in: requestIds },
          },
          select: { rescueRequestId: true },
        })
      : [];
    const succeededRequestIds = new Set(
      succeeded.map((p) => p.rescueRequestId),
    );

    const data = payments.map((p) => ({
      ...p,
      alreadySucceeded: succeededRequestIds.has(p.rescueRequestId),
    }));
    return { data };
  }

  @Post(':id/retry')
  async retry(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const payment = await this.payoutService.retryPayout(id);
    await this.auditLogService.record({
      category: 'payout_retried',
      message: `Retried payout ${id}`,
      details: {
        paymentId: id,
        resultStatus: payment?.status ?? null,
        resultPaymentId: payment?.id ?? null,
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
      return 'Still blocked.';
    case PaymentStatus.FAILED:
      return `Transfer failed${payment.failureReason ? `: ${payment.failureReason}` : '.'}`;
    case PaymentStatus.REVERSED:
      return 'Transfer was reversed.';
    default:
      return 'Payout retried.';
  }
}
