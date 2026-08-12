import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutService } from './payout.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, PayoutStatus } from '@prisma/client';

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
        rescueRequest: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: payouts };
  }

  @Post(':id/retry')
  async retry(@Param('id') id: string) {
    await this.payoutService.retryPayout(id);
    return { message: 'Payout retry initiated' };
  }
}
