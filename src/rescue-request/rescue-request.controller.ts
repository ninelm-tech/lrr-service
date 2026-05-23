
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { RescueRequestService } from './rescue-request.service';
import type { Request } from 'express';
import { AdminRescueRequestQueryDto } from './dto/admin-rescue-request.dto';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller('rescue-requests')
export class RescueRequestController {
  constructor(private readonly rescueRequestService: RescueRequestService) {}

  @Get()
  async list(@Req() req: Request, @Query() query: AdminRescueRequestQueryDto) {
    // req.user will have userId, phone, role
    return this.rescueRequestService.listForUser(req.user, query);
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return this.rescueRequestService.detailForUser(req.user, id);
  }
}
