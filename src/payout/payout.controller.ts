import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutService } from './payout.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, PayoutStatus, PayoutBlockReason } from '@prisma/client';

@Controller('payouts')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PayoutController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payoutService: PayoutService,
  ) {}

  @Get()
  async list(@Query('status') status?: string) {
    const payouts = await this.prisma.payout.findMany({
      where: status ? { status: status as PayoutStatus } : {},
      include: {
        operator: { select: { businessName: true } },
        rescueRequest: {
          select: { id: true, disputed: true, disputeResolvedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: payouts };
  }

  @Post(':id/retry')
  async retry(@Param('id') id: string) {
    const payout = await this.payoutService.retryPayout(id);
    return { message: describeRetryOutcome(payout), data: payout };
  }
}

/**
 * A retry can legitimately end up re-blocked — most commonly because the
 * operator still hasn't added bank details. Reporting that as "retry
 * initiated" tells the admin the opposite of what happened, so the message
 * reflects the payout's actual resulting state.
 */
function describeRetryOutcome(
  payout: {
    status: PayoutStatus;
    blockReason: PayoutBlockReason | null;
    failureReason: string | null;
  } | null,
): string {
  if (!payout)
    return 'Payout retried, but its current state could not be read.';

  switch (payout.status) {
    case PayoutStatus.PROCESSING:
      return 'Transfer initiated — awaiting confirmation from Paystack.';
    case PayoutStatus.SUCCESS:
      return 'Payout completed.';
    case PayoutStatus.PENDING:
      if (payout.blockReason === PayoutBlockReason.NO_BANK_DETAILS) {
        return 'Still blocked — this operator has no bank details on file. Add them, then retry.';
      }
      if (payout.blockReason === PayoutBlockReason.INSUFFICIENT_BALANCE) {
        return 'Still blocked — the Paystack balance is too low to cover this payout.';
      }
      return 'Still pending.';
    case PayoutStatus.FAILED:
      return `Transfer failed${payout.failureReason ? `: ${payout.failureReason}` : '.'}`;
    default:
      return 'Payout retried.';
  }
}
