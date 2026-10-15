import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Decorators here are documentation only (no global ValidationPipe is
 * wired up in this app — see OperatorService.setDepositPercent for where
 * the real enforcement lives, including rejecting a missing field,
 * which @IsOptional() would NOT do even if a pipe existed). @Min(0) is a
 * static floor for documentation purposes only — the real floor is the
 * platform's current default deposit percent, fetched live, which is
 * always >= 0 but can't be expressed as a static decorator.
 */
export class SetDepositPercentDto {
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(50)
  depositPercentOverride: number | null;
}
