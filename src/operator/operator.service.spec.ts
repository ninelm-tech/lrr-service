import { Test, TestingModule } from '@nestjs/testing';
import { OperatorService } from './operator.service';
import { PrismaService } from '../prisma/prisma.service';
import { TruckClass } from '@prisma/client';

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
});
