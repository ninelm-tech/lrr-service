import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { StaffService } from './staff.service';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { parsePagination } from '../common/pagination.util';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

/** Internal team: SUPER_ADMIN / ADMIN / PRODUCT. Customers and operators are not listed here. */
@UseGuards(AuthGuard, RolesGuard)
@Controller('admin/staff')
export class StaffController {
  constructor(
    private readonly staffService: StaffService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  async list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.staffService.list({
      search: search?.trim() || undefined,
      ...parsePagination(page, limit),
    });
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    const { user, before, after } = await this.staffService.update(
      id,
      dto,
      req.user.userId,
    );
    await this.auditLogService.record({
      category: 'staff_updated',
      message: `Updated staff account ${id}`,
      details: { targetId: id, before, after },
      actorId: req.user.userId,
    });
    return { message: 'Staff member updated', data: user };
  }
}
