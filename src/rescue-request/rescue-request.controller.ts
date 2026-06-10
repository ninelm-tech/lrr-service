
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RescueRequestService } from './rescue-request.service';
import type { Request } from 'express';
import { AdminRescueRequestQueryDto } from './dto/admin-rescue-request.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(AuthGuard)
@Controller('rescue-requests')
export class RescueRequestController {
  constructor(private readonly rescueRequestService: RescueRequestService) {}

  @Get()
  async list(@Req() req: Request, @Query() query: AdminRescueRequestQueryDto) {
    // req.user will have userId, phone, role
    return this.rescueRequestService.listForUser(req.user, query);
  }

  // ── Dispatch offers (operator dashboard) ─────────────────────────────────
  // Declared before ':id' to avoid param shadowing.

  /** Pending offers for the logged-in operator's business(es). */
  @Get('offers/mine')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async myOffers(@Req() req: Request) {
    return this.rescueRequestService.listMyPendingOffers((req.user as any).userId);
  }

  /** Accept or decline a pending offer from the dashboard. */
  @Post('offers/:offerId/respond')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async respondToOffer(
    @Req() req: Request,
    @Param('offerId') offerId: string,
    @Body() body: { accept: boolean },
  ) {
    return this.rescueRequestService.respondToOffer(
      (req.user as any).userId,
      offerId,
      Boolean(body.accept),
    );
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return this.rescueRequestService.detailForUser(req.user, id);
  }

  // ── Admin mutations ─────────────────────────────────────────────────────

  /** Manually assign an operator (e.g. when auto-dispatch found nobody). */
  @Patch(':id/assign-operator')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async assignOperator(
    @Param('id') id: string,
    @Body() body: { operatorId: string },
  ) {
    return this.rescueRequestService.assignOperator(id, { operatorId: body.operatorId });
  }

  /** Update request status (admin override). */
  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.rescueRequestService.updateStatus(id, { status: body.status });
  }

  /** Cancel a request, optionally with a reason sent to the customer. */
  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.rescueRequestService.cancel(id, { reason: body.reason });
  }
}
