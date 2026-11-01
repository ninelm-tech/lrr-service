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
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });

      const result = await service.getConfig();

      expect(result).toEqual({
        serviceFeePercent: 10,
        depositPercent: 10,
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });
    });

    it('includes testCustomerPhoneNumbers from the row', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: ['+2348012345678'],
      });

      const result = await service.getConfig();

      expect(result.testCustomerPhoneNumbers).toEqual(['+2348012345678']);
    });

    it('exposes quoteCollectionMinutes — the phase-2 window dispatch reads on the first quote', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 7,
        disputeAlertPhoneNumbers: [],
      });

      expect((await service.getConfig()).quoteCollectionMinutes).toBe(7);
    });

    it('includes disputeAlertPhoneNumbers, empty when unset', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: [],
        newRequestAlertPhoneNumbers: [],
      });

      const result = await service.getConfig();

      expect(result.disputeAlertPhoneNumbers).toEqual([]);
      expect(result.newRequestAlertPhoneNumbers).toEqual([]);
    });

    it('includes disputeAlertPhoneNumbers and newRequestAlertPhoneNumbers from the row', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: ['+2348012345678', '+2348012345679'],
        newRequestAlertPhoneNumbers: ['+2348012345680'],
      });

      const result = await service.getConfig();

      expect(result.disputeAlertPhoneNumbers).toEqual([
        '+2348012345678',
        '+2348012345679',
      ]);
      expect(result.newRequestAlertPhoneNumbers).toEqual(['+2348012345680']);
    });
  });

  describe('updateConfig', () => {
    it('rejects a serviceFeePercent below 0', async () => {
      await expect(
        service.updateConfig({ serviceFeePercent: -1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a depositPercent above 50', async () => {
      await expect(
        service.updateConfig({ depositPercent: 51 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a depositPercent below 10 — 0% deposit must never be configurable', async () => {
      await expect(service.updateConfig({ depositPercent: 9 })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.updateConfig({ depositPercent: 0 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts a depositPercent of exactly 10', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });

      const result = await service.updateConfig({ depositPercent: 10 });

      expect(result.depositPercent).toBe(10);
    });

    it('accepts a depositPercent of exactly 50', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 50 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });

      const result = await service.updateConfig({ depositPercent: 50 });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { depositPercent: 50 },
      });
      expect(result.depositPercent).toBe(50);
    });

    it('rejects a dispatchWindowMinutes outside 1-60', async () => {
      await expect(
        service.updateConfig({ dispatchWindowMinutes: 0 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateConfig({ dispatchWindowMinutes: 61 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a dispatchBatchSize outside 1-20', async () => {
      await expect(
        service.updateConfig({ dispatchBatchSize: 0 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateConfig({ dispatchBatchSize: 21 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a quoteCollectionMinutes outside 1-60', async () => {
      await expect(
        service.updateConfig({ quoteCollectionMinutes: 0 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateConfig({ quoteCollectionMinutes: 61 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('persists a new quoteCollectionMinutes', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 8,
        disputeAlertPhoneNumbers: [],
      });

      const result = await service.updateConfig({ quoteCollectionMinutes: 8 });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { quoteCollectionMinutes: 8 },
      });
      expect(result.quoteCollectionMinutes).toBe(8);
    });

    it('updates the singleton row when values are valid', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 15 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 15,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });

      const result = await service.updateConfig({
        serviceFeePercent: 15,
        dispatchWindowMinutes: 15,
      });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { serviceFeePercent: 15, dispatchWindowMinutes: 15 },
      });
      expect(result).toEqual({
        serviceFeePercent: 15,
        depositPercent: 10,
        dispatchWindowMinutes: 15,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });
    });

    it('persists a new dispatchBatchSize', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 5,
        disputeAlertPhoneNumbers: [],
      });

      const result = await service.updateConfig({ dispatchBatchSize: 5 });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { dispatchBatchSize: 5 },
      });
      expect(result.dispatchBatchSize).toBe(5);
    });

    it('normalizes disputeAlertPhoneNumbers to E.164 before persisting', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: ['+2348012345678'],
      });

      const result = await service.updateConfig({
        disputeAlertPhoneNumbers: ['08012345678'],
      });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { disputeAlertPhoneNumbers: ['+2348012345678'] },
      });
      expect(result.disputeAlertPhoneNumbers).toEqual(['+2348012345678']);
    });

    it('rejects an invalid number in disputeAlertPhoneNumbers', async () => {
      await expect(
        service.updateConfig({ disputeAlertPhoneNumbers: ['not-a-phone'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects more than 10 disputeAlertPhoneNumbers', async () => {
      const elevenNumbers = Array.from(
        { length: 11 },
        (_, i) => `+23480123456${i.toString().padStart(2, '0')}`,
      );

      await expect(
        service.updateConfig({ disputeAlertPhoneNumbers: elevenNumbers }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts exactly 10 disputeAlertPhoneNumbers', async () => {
      const tenNumbers = Array.from(
        { length: 10 },
        (_, i) => `+23480123456${i.toString().padStart(2, '0')}`,
      );
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: tenNumbers,
      });

      const result = await service.updateConfig({
        disputeAlertPhoneNumbers: tenNumbers,
      });

      expect(result.disputeAlertPhoneNumbers).toEqual(tenNumbers);
    });

    it('normalizes newRequestAlertPhoneNumbers to E.164 before persisting', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        newRequestAlertPhoneNumbers: ['+2348012345678'],
      });

      const result = await service.updateConfig({
        newRequestAlertPhoneNumbers: ['08012345678'],
      });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { newRequestAlertPhoneNumbers: ['+2348012345678'] },
      });
      expect(result.newRequestAlertPhoneNumbers).toEqual(['+2348012345678']);
    });

    it('rejects an invalid number in newRequestAlertPhoneNumbers', async () => {
      await expect(
        service.updateConfig({
          newRequestAlertPhoneNumbers: ['not-a-phone'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects more than 10 newRequestAlertPhoneNumbers', async () => {
      const elevenNumbers = Array.from(
        { length: 11 },
        (_, i) => `+23480123456${i.toString().padStart(2, '0')}`,
      );

      await expect(
        service.updateConfig({ newRequestAlertPhoneNumbers: elevenNumbers }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts exactly 10 newRequestAlertPhoneNumbers', async () => {
      const tenNumbers = Array.from(
        { length: 10 },
        (_, i) => `+23480123456${i.toString().padStart(2, '0')}`,
      );
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        newRequestAlertPhoneNumbers: tenNumbers,
      });

      const result = await service.updateConfig({
        newRequestAlertPhoneNumbers: tenNumbers,
      });

      expect(result.newRequestAlertPhoneNumbers).toEqual(tenNumbers);
    });

    it('normalizes testCustomerPhoneNumbers to E.164 before persisting', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        disputeAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: ['+2348012345678'],
      });

      await service.updateConfig({
        testCustomerPhoneNumbers: ['08012345678'],
      });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { testCustomerPhoneNumbers: ['+2348012345678'] },
      });
    });

    it('rejects an invalid number in testCustomerPhoneNumbers', async () => {
      await expect(
        service.updateConfig({ testCustomerPhoneNumbers: ['not-a-phone'] }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
