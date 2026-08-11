import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RatingService } from './rating.service';
import { RatingDetailDto, SubmitRatingCommentDto } from './dto/rating.dto';

@Controller('ratings')
export class RatingController {
  constructor(
    private readonly ratingService: RatingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id')
  async detail(@Param('id') id: string): Promise<{ data: RatingDetailDto }> {
    const rating = await this.prisma.rating.findUnique({
      where: { id },
      include: { operator: { select: { businessName: true } } },
    });
    if (!rating) throw new NotFoundException('Rating not found');

    const ratedName = rating.direction === 'MOTORIST_TO_OPERATOR'
      ? rating.operator.businessName
      : 'the motorist';

    return {
      data: { ratedName, score: rating.score, comment: rating.comment },
    };
  }

  @Patch(':id')
  async updateComment(
    @Param('id') id: string,
    @Body() body: SubmitRatingCommentDto,
  ): Promise<{ data: { comment: string | null } }> {
    // Manual check, not just the DTO's decorators — this app has no global
    // ValidationPipe wired up yet, so class-validator decorators alone
    // don't currently run. Keep this until that gap is addressed.
    if (!body.comment || !body.comment.trim()) {
      throw new BadRequestException('comment is required');
    }
    const updated = await this.ratingService.setComment(id, body.comment);
    return { data: { comment: updated.comment } };
  }
}
