
import { Body, Controller, Header, Post, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { RescueRequestService } from './rescue-request.service';
import type { Request } from 'express';
import { AdminRescueRequestQueryDto } from './dto/admin-rescue-request.dto';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller()
export class RescueRequestController {
  constructor(private readonly rescueRequestService: RescueRequestService) {}

  @Post('webhooks/rescue-request/whatsapp')
  @Header('Content-Type', 'text/xml')
  receiveWhatsAppMessage(@Body() body: Record<string, any>) {
    return this.rescueRequestService.handleIncomingWhatsAppMessage(body);
  }

  @Get('rescue-requests')
  async list(@Req() req: Request, @Query() query: AdminRescueRequestQueryDto) {
    // req.user will have userId, phone, role
    return this.rescueRequestService.listForUser(req.user, query);
  }

  @Get('rescue-requests/:id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return this.rescueRequestService.detailForUser(req.user, id);
  }
}
