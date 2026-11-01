import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RescueRequestStatus, UserRole } from '@prisma/client';
import { DisputeService } from './dispute.service';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import type { Request } from 'express';
import { AdminRescueRequestQueryDto } from './dto/admin-rescue-request.dto';
import { AssignOperatorDto } from './dto/assign-operator.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { ResolveCancellationSettlementDto } from './dto/resolve-cancellation-settlement.dto';
import { ManualOverrideDto } from './dto/manual-override.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

@UseGuards(AuthGuard)
@Controller('rescue-requests')
export class RescueRequestController {
  constructor(
    private readonly disputeService: DisputeService,
    private readonly rescueRequestAdminService: RescueRequestAdminService,
    private readonly dispatchService: DispatchService,
    private readonly auditLogService: AuditLogService,
    private readonly operatorFlowService: WhatsAppOperatorFlowService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query() query: AdminRescueRequestQueryDto) {
    // req.user will have userId, phone, role
    return this.rescueRequestAdminService.listForUser(req.user, query);
  }

  // ── Dispatch offers (operator dashboard) ─────────────────────────────────
  // Declared before ':id' to avoid param shadowing.

  /** Pending offers for the logged-in operator's business(es). */
  @Get('offers/mine')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async myOffers(@Req() req: Request) {
    return this.dispatchService.listMyPendingOffers((req.user as any).userId);
  }

  /** Submit a quote or decline a pending offer from the dashboard. */
  @Post('offers/:offerId/respond')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async respondToOffer(
    @Req() req: Request,
    @Param('offerId') offerId: string,
    @Body() body: { priceNaira?: number },
  ) {
    const priceKobo =
      body.priceNaira !== undefined
        ? Math.round(body.priceNaira * 100)
        : undefined;
    return this.dispatchService.respondToOffer(
      (req.user as any).userId,
      offerId,
      priceKobo,
    );
  }

  /** Live + recent dispatch state across all requests, for the admin ops board. */
  @Get('dispatch-board')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.PRODUCT)
  async dispatchBoard() {
    const rows = await this.dispatchService.getDispatchBoard();
    return { data: rows };
  }

  @Post(':id/expand-radius')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async expandRadius(@Param('id') id: string) {
    await this.dispatchService.expandRadiusNow(id);
    return { message: 'Radius expansion triggered' };
  }

  @Post(':id/offer-to/:operatorId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async offerToOperator(
    @Param('id') id: string,
    @Param('operatorId') operatorId: string,
  ) {
    await this.dispatchService.manualOfferToOperator(id, operatorId);
    return { message: 'Offer sent' };
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return this.rescueRequestAdminService.detailForUser(req.user, id);
  }

  // ── Admin mutations ─────────────────────────────────────────────────────

  /**
   * Manually assign an operator (e.g. when auto-dispatch found nobody).
   * Requires the agreed price — this goes through the same fee split and
   * deposit-payment-link flow as a customer selecting a quote themselves.
   */
  @Patch(':id/assign-operator')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async assignOperator(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AssignOperatorDto,
  ) {
    const result = await this.rescueRequestAdminService.assignOperator(id, dto);
    if (result.data.assignedOperator?.whatsappEnabled === false) {
      await this.auditLogService.record({
        category: 'manual_assignment_confirmed',
        message: `Manually assigned ${result.data.assignedOperator.businessName} to request ${id}`,
        details: {
          targetType: 'RescueRequest',
          targetId: id,
          operatorId: result.data.assignedOperator.id,
          businessName: result.data.assignedOperator.businessName,
        },
        actorId: req.user.userId,
      });
    }
    return result;
  }

  /**
   * Admin-triggered refund for a deposit that arrived after its request was
   * already cancelled. Always refunds the full deposit amount.
   *
   * SUPER_ADMIN only — like payouts, this moves platform money out to a
   * customer, not just a payment link the customer acts on.
   */
  @Post(':id/refund-deposit')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async refundDeposit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const depositAmount =
      await this.rescueRequestAdminService.getDepositAmount(id);
    await this.rescueRequestAdminService.refundDeposit(id);
    await this.auditLogService.record({
      category: 'deposit_refunded',
      message: `Refunded deposit for rescue request ${id}`,
      details: {
        rescueRequestId: id,
        before: { refunded: false },
        after: { refunded: true, amount: depositAmount },
      },
      actorId: req.user.userId,
    });
    return { message: 'Refund initiated' };
  }

  /** Update request status (admin override). */
  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.rescueRequestAdminService.updateStatus(id, {
      status: body.status,
    });
  }

  /** Cancel a request, optionally with a reason sent to the customer. */
  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.rescueRequestAdminService.cancel(id, { reason: body.reason });
  }

  /**
   * Staff stand-in for an operator sending ARRIVED over WhatsApp. Usable
   * without a reason when the assigned operator has no WhatsApp on file —
   * the original, already-legitimate path, where staff and the operator's
   * own replies can never race over the same status. For a WhatsApp-enabled
   * operator (their account may have gone BSUID-masked mid-job — see the
   * WhatsApp username/BSUID identity design doc), the override still
   * requires a non-empty `reason`, since here a real WhatsApp conversation
   * could in principle still be live.
   *
   * The pre-check below (`findRawForManualAction`) is what produces a
   * precise error message; it is NOT the concurrency guard. The guard is
   * `claimManualArrived`'s own atomic conditional update — if two staff
   * members click this at once, or the request moved on between the
   * pre-check and the claim, only one claim can ever succeed, and only the
   * winner notifies the customer or writes an audit entry.
   */
  @Patch(':id/manual-arrived')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async manualArrived(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ManualOverrideDto,
  ) {
    const request =
      await this.rescueRequestAdminService.findRawForManualAction(id);
    if (!request) throw new NotFoundException('Rescue request not found');
    if (request.assignedOperator?.whatsappEnabled && !body.reason) {
      throw new BadRequestException(
        'This operator has WhatsApp on file — a reason is required to override arrival tracking manually.',
      );
    }
    if (request.status !== RescueRequestStatus.OPERATOR_ASSIGNED) {
      throw new BadRequestException(
        `Cannot mark arrived — request is ${request.status}, expected OPERATOR_ASSIGNED.`,
      );
    }

    const { claimed } = await this.rescueRequestAdminService.claimManualArrived(
      id,
      { reason: body.reason },
    );
    if (!claimed) {
      throw new BadRequestException(
        'This request is no longer eligible for a manual arrival — it may already have been marked, or its status changed.',
      );
    }

    await this.operatorFlowService.notifyCustomerOperatorArrived(id);
    await this.auditLogService.record({
      category: 'manual_operator_arrived',
      message: `Marked operator arrived for request ${id}${
        body.reason ? ` (override: ${body.reason})` : ' (no WhatsApp on file)'
      }`,
      details: {
        targetType: 'RescueRequest',
        targetId: id,
        operatorId: request.assignedOperatorId,
        reason: body.reason,
      },
      actorId: req.user.userId,
    });
    return { message: 'Marked arrived' };
  }

  /**
   * Staff stand-in for an operator sending DONE over WhatsApp — same
   * whatsappEnabled-vs-reason guard as manual-arrived. Deliberately does
   * NOT require completion media (product decision, see the design spec)
   * — the WhatsApp path's own DONE handler is completely untouched and
   * still requires it.
   *
   * Unlike manual-arrived, the atomic claim itself lives inside
   * `startManualCompletionConfirmation` (Task 9) — that method is
   * self-contained since it isn't shared with any WhatsApp-path method, so
   * there's no separate `claimManualDone` helper here; this endpoint's own
   * two checks below are still pre-check-only, for the same precise-error
   * reason as manual-arrived.
   */
  @Patch(':id/manual-done')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async manualDone(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ManualOverrideDto,
  ) {
    const request =
      await this.rescueRequestAdminService.findRawForManualAction(id);
    if (!request) throw new NotFoundException('Rescue request not found');
    if (request.assignedOperator?.whatsappEnabled && !body.reason) {
      throw new BadRequestException(
        'This operator has WhatsApp on file — a reason is required to override completion tracking manually.',
      );
    }
    if (request.status !== RescueRequestStatus.ARRIVED) {
      throw new BadRequestException(
        `Cannot mark done — request is ${request.status}, expected ARRIVED.`,
      );
    }

    const { claimed } =
      await this.operatorFlowService.startManualCompletionConfirmation(id, {
        reason: body.reason,
      });
    if (!claimed) {
      throw new BadRequestException(
        'This request is no longer eligible for manual completion — it may already have been marked, or its status changed.',
      );
    }

    await this.auditLogService.record({
      category: 'manual_operator_done',
      message: `Marked operator done for request ${id}${
        body.reason ? ` (override: ${body.reason})` : ' (no WhatsApp on file)'
      }`,
      details: {
        targetType: 'RescueRequest',
        targetId: id,
        operatorId: request.assignedOperatorId,
        reason: body.reason,
      },
      actorId: req.user.userId,
    });
    return { message: 'Marked done — awaiting customer confirmation' };
  }

  /**
   * Live-ranked candidates for a request flagged needsManualAssignment —
   * the same whatsappOnly: false search resolveExhaustion's own fallback
   * used, re-run fresh rather than persisted, so staff always see current
   * operator availability.
   */
  @Get(':id/manual-candidates')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async manualCandidates(@Param('id') id: string) {
    return this.rescueRequestAdminService.manualCandidatesFor(id);
  }

  /** Mark a disputed request resolved. Idempotent — safe to call more than once. */
  @Patch(':id/resolve-dispute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async resolveDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    const result = await this.disputeService.resolveDispute(
      id,
      dto.resolutionNote,
      dto.balanceAdjustmentPercent,
    );
    await this.auditLogService.record({
      category: 'dispute_resolved',
      message: `Resolved dispute for rescue request ${id}`,
      details: {
        rescueRequestId: id,
        resolutionNote: dto.resolutionNote,
        balanceAdjustmentPercent: dto.balanceAdjustmentPercent,
        before: { balanceAmount: result.originalBalance },
        after: { balanceAmount: result.settledBalance },
      },
      actorId: req.user.userId,
    });
    return result;
  }

  /**
   * Cancellation-after-dispatch settlement: splits an already-paid deposit
   * between a customer refund and a payout to the assigned operator, for a
   * request cancelled once self-cancel is blocked (see
   * BLOCKED_FROM_SELF_CANCEL in whatsapp-customer-flow.service.ts) and
   * support has agreed a split with the customer.
   *
   * SUPER_ADMIN only — like refund-deposit and payouts, this moves
   * platform money out on both sides of the split, not just a payment
   * link the customer acts on themselves.
   */
  @Patch(':id/resolve-cancellation-settlement')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async resolveCancellationSettlement(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ResolveCancellationSettlementDto,
  ) {
    const result =
      await this.rescueRequestAdminService.resolveCancellationSettlement(
        id,
        dto.resolutionNote,
        dto.customerRefundPercent,
      );
    await this.auditLogService.record({
      category: 'cancellation_settled',
      message: `Resolved cancellation settlement for rescue request ${id}`,
      details: {
        rescueRequestId: id,
        resolutionNote: dto.resolutionNote,
        customerRefundPercent: dto.customerRefundPercent,
        feeKeptOut: result.feeKeptOut,
        refundAmount: result.refundAmount,
        payoutAmount: result.payoutAmount,
      },
      actorId: req.user.userId,
    });
    return result;
  }
}
