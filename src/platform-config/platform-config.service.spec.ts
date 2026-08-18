import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PlatformConfigService } from './platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PlatformConfigService', () => {
  let service: PlatformConfigService;
  let prisma: {
    platformConfig: { findFirst: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      platformConfig: { findFirst: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PlatformConfigService>(PlatformConfigService);
  });

  describe('getConfig', () => {
    it('returns the singleton row as plain numbers', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        disputeAlertPhoneNumber: null,
      });

      const result = await service.getConfig();

      expect(result).toEqual({ serviceFeePercent: 10, depositPercent: 10, dispatchWindowMinutes: 10, disputeAlertPhoneNumber: null });
    });

    it('includes disputeAlertPhoneNumber, null when unset', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        disputeAlertPhoneNumber: null,
      });

      const result = await service.getConfig();

      expect(result.disputeAlertPhoneNumber).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('rejects a serviceFeePercent below 0', async () => {
      await expect(service.updateConfig({ serviceFeePercent: -1 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a depositPercent above 100', async () => {
      await expect(service.updateConfig({ depositPercent: 101 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a dispatchWindowMinutes outside 1-60', async () => {
      await expect(service.updateConfig({ dispatchWindowMinutes: 0 })).rejects.toThrow(BadRequestException);
      await expect(service.updateConfig({ dispatchWindowMinutes: 61 })).rejects.toThrow(BadRequestException);
    });

    it('updates the singleton row when values are valid', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 15 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 15,
        disputeAlertPhoneNumber: null,
      });

      const result = await service.updateConfig({ serviceFeePercent: 15, dispatchWindowMinutes: 15 });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { serviceFeePercent: 15, dispatchWindowMinutes: 15 },
      });
      expect(result).toEqual({ serviceFeePercent: 15, depositPercent: 10, dispatchWindowMinutes: 15, disputeAlertPhoneNumber: null });
    });

    it('persists a new disputeAlertPhoneNumber', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        disputeAlertPhoneNumber: '+2348012345678',
      });

      const result = await service.updateConfig({ disputeAlertPhoneNumber: '+2348012345678' });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { disputeAlertPhoneNumber: '+2348012345678' },
      });
      expect(result.disputeAlertPhoneNumber).toBe('+2348012345678');
    });
  });
});
