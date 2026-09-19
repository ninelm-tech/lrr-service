import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PlatformConfigService } from './platform-config.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { pickChangedFields } from '../audit-log/domain/pick-changed-fields';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

@UseGuards(AuthGuard)
@Controller('admin/settings')
export class PlatformConfigController {
  constructor(
    private readonly platformConfigService: PlatformConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async getSettings() {
    const data = await this.platformConfigService.getConfig();
    return { data };
  }

  @Patch()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdatePlatformConfigDto,
  ) {
    const before = await this.platformConfigService.getConfig();
    const data = await this.platformConfigService.updateConfig(dto);
    // This affects every future transaction platform-wide — arguably the
    // single highest-blast-radius admin action in the app, so the changed
    // fields go in `details` as a before/after pair rather than just the
    // new values.
    const changedKeys = Object.keys(dto) as (keyof UpdatePlatformConfigDto)[];
    await this.auditLogService.record({
      category: 'platform_settings_updated',
      message: 'Updated platform settings',
      details: {
        before: pickChangedFields(before, changedKeys),
        after: pickChangedFields(data, changedKeys),
      },
      actorId: req.user.userId,
    });
    return { data };
  }
}
