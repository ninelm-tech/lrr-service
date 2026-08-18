import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdatePlatformConfigDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  serviceFeePercent?: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  depositPercent?: number;

  @IsInt()
  @Min(1)
  @Max(60)
  @IsOptional()
  dispatchWindowMinutes?: number;

  @IsString()
  @IsOptional()
  disputeAlertPhoneNumber?: string;
}
