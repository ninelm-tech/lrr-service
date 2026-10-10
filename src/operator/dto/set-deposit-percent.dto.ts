import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Decorators here are documentation only (no global ValidationPipe is
 * wired up in this app — see OperatorService.setDepositPercent for where
 * the real enforcement lives, including rejecting a missing field,
 * which @IsOptional() would NOT do even if a pipe existed).
 */
export class SetDepositPercentDto {
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  depositPercentOverride: number | null;
}
