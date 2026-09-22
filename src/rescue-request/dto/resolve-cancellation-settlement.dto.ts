import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class ResolveCancellationSettlementDto {
  /** Staff's record of what happened and why this split was decided. */
  @IsString()
  @MinLength(1)
  resolutionNote: string;

  /**
   * 0-100 — how much of the deposit goes back to the customer; the
   * operator receives the remainder. Required (no default): unlike
   * balanceAdjustmentPercent's "omit for no change", there's no safe
   * silent default here — 100 and 0 are both meaningful, deliberate
   * choices, not a fallback.
   */
  @IsInt()
  @Min(0)
  @Max(100)
  customerRefundPercent: number;
}
