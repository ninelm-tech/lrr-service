import { IsNotEmpty, IsString } from 'class-validator';

export class RatingDetailDto {
  ratedName: string;
  score: number;
  comment: string | null;
}

export class SubmitRatingCommentDto {
  @IsString()
  @IsNotEmpty()
  comment: string;
}
