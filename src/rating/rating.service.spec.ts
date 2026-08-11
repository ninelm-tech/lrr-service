import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RatingService } from './rating.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RatingService', () => {
  let service: RatingService;
  let prisma: { rating: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      rating: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RatingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<RatingService>(RatingService);
  });

  describe('create', () => {
    it('creates a rating row for the given direction', async () => {
      prisma.rating.create.mockResolvedValue({ id: 'rating-1', score: 5, direction: 'MOTORIST_TO_OPERATOR' });
      const result = await service.create({
        rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5,
      });
      expect(prisma.rating.create).toHaveBeenCalledWith({
        data: { rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5 },
      });
      expect(result.id).toBe('rating-1');
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      prisma.rating.findUnique.mockResolvedValue(null);
      const result = await service.findById('missing');
      expect(result).toBeNull();
    });
  });

  describe('setComment', () => {
    it('throws NotFoundException when the rating does not exist', async () => {
      prisma.rating.findUnique.mockResolvedValue(null);
      await expect(service.setComment('missing', 'text')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when a comment already exists', async () => {
      prisma.rating.findUnique.mockResolvedValue({ id: 'rating-1', comment: 'already here' });
      await expect(service.setComment('rating-1', 'new text')).rejects.toThrow(BadRequestException);
      expect(prisma.rating.update).not.toHaveBeenCalled();
    });

    it('sets comment on a rating with no existing comment', async () => {
      prisma.rating.findUnique.mockResolvedValue({ id: 'rating-1', comment: null });
      prisma.rating.update.mockResolvedValue({ id: 'rating-1', comment: 'Great service' });
      const result = await service.setComment('rating-1', 'Great service');
      expect(prisma.rating.update).toHaveBeenCalledWith({
        where: { id: 'rating-1' },
        data: { comment: 'Great service' },
      });
      expect(result.comment).toBe('Great service');
    });
  });
});
