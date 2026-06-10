import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OperatorService } from './operator.service';
import type { UpdateOperatorProfileDto } from './operator.service';
import { OperatorMemberRole, OperatorStatus, OperatorType, UserRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

class CreateOperatorDto {
  email: string;
  password: string;
  name?: string;
  type?: OperatorType;
  businessName: string;
  contactName: string;
  phoneNumber: string;
  address: string;
  latitude: number;
  longitude: number;
  serviceRadius?: number;
}

@Controller('operators')
export class OperatorController {
  constructor(private readonly operatorService: OperatorService) {}

  /**
   * Register a new operator
   */
  @Post()
  async create(@Body() dto: CreateOperatorDto) {
    const result = await this.operatorService.create(dto);
    return {
      message: 'Operator registered successfully. Pending approval.',
      data: {
        userId: result.user.id,
        operatorId: result.operator.id,
        status: result.operator.status,
      },
    };
  }

  /**
   * Get all operators
   */
  @UseGuards(AuthGuard)
  @Get()
  async findAll() {
    const operators = await this.operatorService.findAll();
    return { data: operators };
  }

  /**
   * Get performance stats for ALL operators — admin leaderboard.
   * Must be declared BEFORE `:id` routes to avoid param shadowing.
   */
  @UseGuards(AuthGuard)
  @Get('all-stats')
  async getAllStats(@Query('days') days?: string) {
    const stats = await this.operatorService.getAllOperatorStats(days ? parseInt(days, 10) : 30);
    return { data: stats };
  }

  /**
   * Get the operator record for the currently authenticated user.
   * Used by the operator dashboard to load their own operator profile.
   */
  @UseGuards(AuthGuard)
  @Get('me')
  async getMyOperator(@Req() req: any) {
    const operator = await this.operatorService.findByUserId(req.user.userId);
    if (!operator) throw new NotFoundException('No operator account found for this user');
    return { data: operator };
  }

  /**
   * Get an operator by ID
   */
  @UseGuards(AuthGuard)
  @Get(':id')
  async findById(@Param('id') id: string) {
    const operator = await this.operatorService.findById(id);
    return { data: operator };
  }

  /**
   * Get performance stats for a single operator
   */
  @UseGuards(AuthGuard)
  @Get(':id/stats')
  async getStats(@Param('id') id: string, @Query('days') days?: string) {
    const stats = await this.operatorService.getOperatorStats(id, days ? parseInt(days, 10) : 30);
    return { data: stats };
  }

  /**
   * Update operator business profile.
   * Allowed: admins, or OWNER/MANAGER members of this operator.
   */
  @UseGuards(AuthGuard)
  @Patch(':id')
  async updateProfile(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateOperatorProfileDto,
  ) {
    await this.operatorService.assertCanManageOperator(req.user, id);
    const operator = await this.operatorService.updateProfile(id, dto);
    return { message: 'Operator profile updated', data: operator };
  }

  /**
   * Update operator status (verification) — admin only.
   */
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: OperatorStatus,
  ) {
    const operator = await this.operatorService.updateStatus(id, status);
    return {
      message: `Operator status updated to ${status}`,
      data: operator,
    };
  }

  /**
   * Toggle operator availability — any member of this operator, or admin.
   */
  @UseGuards(AuthGuard)
  @Patch(':id/availability')
  async setAvailability(
    @Req() req: any,
    @Param('id') id: string,
    @Body('isAvailable') isAvailable: boolean,
  ) {
    await this.operatorService.assertIsMemberOrAdmin(req.user, id);
    const operator = await this.operatorService.setAvailability(id, Boolean(isAvailable));
    return {
      message: `Operator availability set to ${isAvailable}`,
      data: operator,
    };
  }

  // ═══════════════════════════════════════
  //  Member management
  // ═══════════════════════════════════════

  @UseGuards(AuthGuard)
  @Get(':id/members')
  async listMembers(@Req() req: any, @Param('id') id: string) {
    await this.operatorService.assertIsMemberOrAdmin(req.user, id);
    const members = await this.operatorService.listMembers(id);
    return { data: members };
  }

  @UseGuards(AuthGuard)
  @Post(':id/members')
  async addMember(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { userId: string; role?: OperatorMemberRole },
  ) {
    await this.operatorService.assertCanManageOperator(req.user, id);
    const member = await this.operatorService.addMember(id, {
      userId: body.userId,
      role:   body.role ?? OperatorMemberRole.STAFF,
    });
    return { message: 'Member added', data: member };
  }

  @UseGuards(AuthGuard)
  @Delete(':id/members/:memberId')
  async removeMember(
    @Req() req: any,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    await this.operatorService.assertCanManageOperator(req.user, id);
    await this.operatorService.removeMember(id, memberId);
    return { message: 'Member removed' };
  }
}
