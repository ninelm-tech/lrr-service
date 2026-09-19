import { Controller, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AccountDeletionService } from './account-deletion.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

@Controller()
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AccountDeletionController {
  constructor(
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Delete('users/:id')
  async deleteUser(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.accountDeletionService.deleteUser(id, req.user.userId);
    return { message: 'Account deleted' };
  }

  @Delete('operators/:id')
  async deleteOperator(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.accountDeletionService.deleteOperator(id, req.user.userId);
    return { message: 'Operator deleted' };
  }
}
