import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Rating, RatingDirection } from '@prisma/client';

export interface CreateRatingInput {
  rescueRequestId: string;
  direction: RatingDirection;
  operatorId: string;
  customerId: string;
  score: number;
}

@Injectable()
export class RatingService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateRatingInput): Promise<Rating> {
    const isLowScore = input.score <= 2;
    return this.prisma.rating.create({
      data: isLowScore ? { ...input, flagged: true, flaggedAt: new Date() } : input,
    });
  }

  /**
   * Marks a flagged low-rating reviewed. Idempotent: never-flagged is
   * rejected, already-resolved returns successfully with no side effects —
   * same shape as DisputeService.resolveDispute.
   */
  async resolveFlag(id: string): Promise<{ resolved: boolean }> {
    const existing = await this.prisma.rating.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Rating not found');
    if (!existing.flagged) throw new BadRequestException('This rating was never flagged.');
    if (existing.flaggedResolvedAt) return { resolved: true };

    await this.prisma.rating.update({ where: { id }, data: { flaggedResolvedAt: new Date() } });
    return { resolved: true };
  }

  async findById(id: string): Promise<Rating | null> {
    return this.prisma.rating.findUnique({ where: { id } });
  }

  async setComment(id: string, comment: string): Promise<Rating> {
    const existing = await this.prisma.rating.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Rating not found');
    }
    if (existing.comment !== null) {
      throw new BadRequestException('Feedback already submitted for this rating.');
    }
    return this.prisma.rating.update({ where: { id }, data: { comment } });
  }
}
