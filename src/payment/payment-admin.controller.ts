import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentAdminService } from './payment-admin.service';
import { PaymentListQueryDto } from './dto/payment-list.dto';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

/**
 * Real payment-ledger reads for the admin/operator "Payments" page. Role
 * scoping (staff see everything, an operator sees only their own jobs) lives
 * in PaymentAdminService, same split as RescueRequestController's top-level
 * list route — no RolesGuard here on purpose.
 */
@UseGuards(AuthGuard)
@Controller('payments')
export class PaymentAdminController {
  constructor(private readonly paymentAdminService: PaymentAdminService) {}

  @Get()
  async list(@Req() req: Request, @Query() query: PaymentListQueryDto) {
    return this.paymentAdminService.listForUser(
      (req as AuthenticatedRequest).user,
      query,
    );
  }

  /** Declared as its own literal path — no `:id` route here to collide with. */
  @Get('summary')
  async summary(@Req() req: Request, @Query() query: PaymentListQueryDto) {
    return this.paymentAdminService.summaryForUser(
      (req as AuthenticatedRequest).user,
      query,
    );
  }
}
