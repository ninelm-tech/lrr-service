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
    return this.prisma.rating.create({ data: input });
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
