import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TruckClass } from '@prisma/client';
import { CreateOperatorDto } from './dto/create-operator.dto';

describe('OperatorService', () => {
  let service: OperatorService;
  let prisma: {
    operator: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    dispatchOffer: { findMany: jest.Mock };
    rating: { aggregate: jest.Mock; groupBy: jest.Mock };
  };
  let paystackMock: { resolveAccountNumber: jest.Mock; createTransferRecipient: jest.Mock };

  beforeEach(async () => {
    prisma = {
      operator: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      dispatchOffer: { findMany: jest.fn().mockResolvedValue([]) },
      rating: {
        aggregate: jest.fn().mockResolvedValue({ _avg: { score: null }, _count: { score: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    paystackMock = {
      resolveAccountNumber: jest.fn(),
      createTransferRecipient: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystackMock },
      ],
    }).compile();

    service = module.get<OperatorService>(OperatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('saveBankDetails', () => {
    it('resolves the account, creates a recipient, and saves only display-safe fields', async () => {
      paystackMock.resolveAccountNumber.mockResolvedValue({ accountName: 'JOHN DOE' });
      paystackMock.createTransferRecipient.mockResolvedValue({ recipientCode: 'RCP_new123' });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', businessName: 'Swift Towing' });
      prisma.operator.update.mockResolvedValue({
        id: 'op-1', bankName: 'GTBank', accountName: 'JOHN DOE', accountNumberLast4: '6789', paystackRecipientCode: 'RCP_new123',
      });

      const result = await service.saveBankDetails('op-1', { bankCode: '058', bankName: 'GTBank', accountNumber: '0123456789' });

      expect(paystackMock.resolveAccountNumber).toHaveBeenCalledWith('0123456789', '058');
      expect(paystackMock.createTransferRecipient).toHaveBeenCalledWith({
        accountNumber: '0123456789', bankCode: '058', accountName: 'JOHN DOE', businessName: 'Swift Towing',
      });
      expect(prisma.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: { bankName: 'GTBank', accountName: 'JOHN DOE', accountNumberLast4: '6789', paystackRecipientCode: 'RCP_new123' },
      });
      expect(result.accountName).toBe('JOHN DOE');
    });
  });

  describe('getOperatorStats — ratings', () => {
    it('includes averageRating and ratingCount, scoped to ratings received', async () => {
      (prisma.dispatchOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.rating.aggregate as jest.Mock).mockResolvedValue({
        _avg: { score: 4.5 },
        _count: { score: 2 },
      });

      const result = await service.getOperatorStats('op-1');

      expect(prisma.rating.aggregate).toHaveBeenCalledWith({
        where: { operatorId: 'op-1', direction: 'MOTORIST_TO_OPERATOR' },
        _avg: { score: true },
        _count: { score: true },
      });
      expect(result.averageRating).toBe(4.5);
      expect(result.ratingCount).toBe(2);
    });

    it('returns null averageRating and 0 ratingCount for an operator with no ratings', async () => {
      (prisma.dispatchOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.rating.aggregate as jest.Mock).mockResolvedValue({
        _avg: { score: null },
        _count: { score: 0 },
      });

      const result = await service.getOperatorStats('op-1');

      expect(result.averageRating).toBeNull();
      expect(result.ratingCount).toBe(0);
    });
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
