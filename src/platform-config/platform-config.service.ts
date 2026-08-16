import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';

export interface PlatformConfigValues {
  serviceFeePercent: number;
  depositPercent: number;
  dispatchWindowMinutes: number;
}

@Injectable()
export class PlatformConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(): Promise<PlatformConfigValues> {
    const row = await this.prisma.platformConfig.findFirst();
    return {
      serviceFeePercent: row!.serviceFeePercent.toNumber(),
      depositPercent: row!.depositPercent.toNumber(),
      dispatchWindowMinutes: row!.dispatchWindowMinutes,
    };
  }

  async updateConfig(dto: UpdatePlatformConfigDto): Promise<PlatformConfigValues> {
    if (dto.serviceFeePercent !== undefined && (dto.serviceFeePercent < 0 || dto.serviceFeePercent > 100)) {
      throw new BadRequestException('serviceFeePercent must be between 0 and 100');
    }
    if (dto.depositPercent !== undefined && (dto.depositPercent < 0 || dto.depositPercent > 100)) {
      throw new BadRequestException('depositPercent must be between 0 and 100');
    }
    if (dto.dispatchWindowMinutes !== undefined && (dto.dispatchWindowMinutes < 1 || dto.dispatchWindowMinutes > 60)) {
      throw new BadRequestException('dispatchWindowMinutes must be between 1 and 60');
    }

    const existing = await this.prisma.platformConfig.findFirst();

    const data: Record<string, number> = {};
    if (dto.serviceFeePercent !== undefined) data.serviceFeePercent = dto.serviceFeePercent;
    if (dto.depositPercent !== undefined) data.depositPercent = dto.depositPercent;
    if (dto.dispatchWindowMinutes !== undefined) data.dispatchWindowMinutes = dto.dispatchWindowMinutes;

    const updated = await this.prisma.platformConfig.update({
      where: { id: existing!.id },
      data,
    });

    return {
      serviceFeePercent: updated.serviceFeePercent.toNumber(),
      depositPercent: updated.depositPercent.toNumber(),
      dispatchWindowMinutes: updated.dispatchWindowMinutes,
    };
  }
}
