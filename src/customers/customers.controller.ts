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
import { CustomersService } from './customers.service';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { parsePagination } from '../common/pagination.util';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customersService.list({
      search: search?.trim() || undefined,
      ...parsePagination(page, limit),
    });
  }

  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const { customer, changedFields } = await this.customersService.update(
      id,
      dto,
    );
    await this.auditLogService.record({
      category: 'customer_updated',
      message: `Updated customer ${id} (${changedFields.join(', ')})`,
      details: { targetId: id, changedFields },
      actorId: req.user.userId,
    });
    return { message: 'Customer updated', data: customer };
  }
}
