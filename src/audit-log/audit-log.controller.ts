import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditLog, UserRole } from '@prisma/client';
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

    return {
      data: await this.withActorNames(data),
      meta: { total, page: currentPage, limit: take },
    };
  }

  @Patch(':id/review')
  async review(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const data = await this.auditLogService.review(id, req.user.userId);
    return { message: 'Marked reviewed', data };
  }

  /**
   * Resolves each entry's `actorId` to a display name via a live join —
   * deliberately not a name snapshotted at write time, so this stays in
   * sync if a name is corrected later. Falls back to the raw id when no
   * matching `User` row is found (or its `name` is null) — the id is still
   * traceable, an empty display isn't.
   */
  private async withActorNames(
    entries: AuditLog[],
  ): Promise<(AuditLog & { actorName: string | null })[]> {
    const actorIds = [
      ...new Set(
        entries
          .map((entry) => entry.actorId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (actorIds.length === 0) {
      return entries.map((entry) => ({ ...entry, actorName: null }));
    }

    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));

    return entries.map((entry) => {
      if (!entry.actorId) return { ...entry, actorName: null };
      const actor = actorById.get(entry.actorId);
      return { ...entry, actorName: actor?.name ?? entry.actorId };
    });
  }
}
