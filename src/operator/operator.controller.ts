import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { OperatorService } from './operator.service';
import { OperatorStatus, OperatorType } from '@prisma/client';

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
  @Get()
  async findAll() {
    const operators = await this.operatorService.findAll();
    return { data: operators };
  }

  /**
   * Get performance stats for ALL operators — admin leaderboard.
   * Must be declared BEFORE `:id` routes to avoid param shadowing.
   */
  @Get('all-stats')
  async getAllStats(@Query('days') days?: string) {
    const stats = await this.operatorService.getAllOperatorStats(days ? parseInt(days, 10) : 30);
    return { data: stats };
  }

  /**
   * Get an operator by ID
   */
  @Get(':id')
  async findById(@Param('id') id: string) {
    const operator = await this.operatorService.findById(id);
    return { data: operator };
  }

  /**
   * Get performance stats for a single operator
   */
  @Get(':id/stats')
  async getStats(@Param('id') id: string, @Query('days') days?: string) {
    const stats = await this.operatorService.getOperatorStats(id, days ? parseInt(days, 10) : 30);
    return { data: stats };
  }

  /**
   * Update operator status (admin)
   */
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
   * Toggle operator availability
   */
  @Patch(':id/availability')
  async setAvailability(
    @Param('id') id: string,
    @Body('isAvailable') isAvailable: boolean,
  ) {
    const operator = await this.operatorService.setAvailability(id, isAvailable);
    return {
      message: `Operator availability set to ${isAvailable}`,
      data: operator,
    };
  }
}
