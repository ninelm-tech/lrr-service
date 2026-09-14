import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';
import { AuditLogService } from './audit-log.service';

/**
 * Read and review side of the audit log. Writing goes through
 * AuditLogService.record() from wherever the action itself happens —
 * this controller never writes a new entry, only lists them and marks
 * one reviewed.
 *
 * SUPER_ADMIN only: this surfaces the same security-sensitive and
 * financial actions the entries themselves describe (staff creation,
 * refunds, payout retries, settings changes) — no wider audience than
 * those actions already have.
 */
@Controller('audit-log')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AuditLogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  async list(
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const where = category ? { category } : {};

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * take,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: { total, page: currentPage, limit: take } };
  }

  @Patch(':id/review')
  async review(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const data = await this.auditLogService.review(id, req.user.userId);
    return { message: 'Marked reviewed', data };
  }
}
