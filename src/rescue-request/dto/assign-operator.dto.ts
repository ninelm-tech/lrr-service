import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class AssignOperatorDto {
  @IsString()
  @IsNotEmpty()
  operatorId: string;

  /** The agreed job price in kobo, before the platform's service fee is added. */
  @IsInt()
  @IsPositive()
  priceKobo: number;
}
