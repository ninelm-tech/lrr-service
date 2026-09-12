import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class ResolveDisputeDto {
  /** Staff's record of what happened and why the settlement was decided. */
  @IsString()
  @MinLength(1)
  resolutionNote: string;

  /** 1-100. Omit (or 100) for "no change" — the customer pays the original balance. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  balanceAdjustmentPercent?: number;
}
