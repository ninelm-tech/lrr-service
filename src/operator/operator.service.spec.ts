import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { PrismaService } from '../prisma/prisma.service';
import { TruckClass } from '@prisma/client';
import { CreateOperatorDto } from './dto/create-operator.dto';

describe('OperatorService', () => {
  let service: OperatorService;
  let prisma: {
    operator: { findMany: jest.Mock };
    dispatchOffer: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      operator: { findMany: jest.fn() },
      dispatchOffer: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<OperatorService>(OperatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAndRankCandidates truck-class filtering', () => {
    it('passes a hasSome truckClasses filter into the Prisma query when truckClasses is provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(
        6.5, 3.4, [], 0, undefined,
        [TruckClass.LOW_BED, TruckClass.HIAB],
      );

      expect(prisma.operator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            truckClasses: { hasSome: [TruckClass.LOW_BED, TruckClass.HIAB] },
          }),
        }),
      );
    });

    it('omits the truckClasses filter entirely when not provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });

    it('omits the truckClasses filter when given an empty array', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, []);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });
  });

  describe('create() truckClasses server-side enforcement', () => {
    const baseDto = (): CreateOperatorDto => ({
      email: 'op@example.com',
      password: 'password123',
      businessName: 'Acme Towing',
      contactName: 'Jane Doe',
      phoneNumber: '+2348012345678',
      address: '1 Test Street',
      latitude: 6.5,
      longitude: 3.4,
      truckClasses: [TruckClass.LOW_BED],
    });

    it('throws BadRequestException when truckClasses is missing', async () => {
      const dto = baseDto();
      delete (dto as any).truckClasses;

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when truckClasses is an empty array', async () => {
      const dto = { ...baseDto(), truckClasses: [] };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when truckClasses contains an invalid value', async () => {
      const dto = { ...baseDto(), truckClasses: ['NOT_A_REAL_CLASS'] as unknown as TruckClass[] };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });
  });
});
