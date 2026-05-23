import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { AuthGuard } from '../auth/auth.guard';
import type { Request } from 'express';

class InitiateSubscriptionDto {
  planKey: string;      // e.g. 'INDIVIDUAL_MONTHLY'
  vehicleRef?: string;  // required for commercial/fleet plans
}

@UseGuards(AuthGuard)
@Controller('subscriptions')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  /**
   * GET /subscriptions/plans
   * Returns all available plan options with pricing (for the subscribe page).
   */
  @Get('plans')
  getPlans() {
    return { data: this.subscriptionService.getAvailablePlans() };
  }

  /**
   * GET /subscriptions/me
   * Returns the authenticated customer's subscriptions.
   */
  @Get('me')
  async getMySubscriptions(@Req() req: Request) {
    return this.subscriptionService.getMySubscriptions((req.user as any).userId);
  }

  /**
   * POST /subscriptions
   * Initiate a subscription checkout. Returns a Paystack payment URL.
   * The subscription is activated when Paystack fires invoice.payment_success.
   */
  @Post()
  async initiateSubscription(
    @Req() req: Request,
    @Body() dto: InitiateSubscriptionDto,
  ) {
    const result = await this.subscriptionService.initiateSubscription({
      userId:     (req.user as any).userId,
      planKey:    dto.planKey as any,
      vehicleRef: dto.vehicleRef,
    });
    return {
      message: 'Proceed to payment to activate your subscription.',
      data: result,
    };
  }

  /**
   * DELETE /subscriptions/:id
   * Cancel an active subscription.
   */
  @Delete(':id')
  async cancelSubscription(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.subscriptionService.cancelSubscription(
      (req.user as any).userId,
      id,
    );
  }

  /**
   * GET /subscriptions/admin
   * Admin: list all subscriptions with optional filters.
   */
  @Get('admin')
  async adminList(@Query() query: { status?: string; plan?: string; page?: number; limit?: number }) {
    return this.subscriptionService.adminList(query);
  }
}
