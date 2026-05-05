import { IsOptional, IsEnum, IsDateString, IsInt } from 'class-validator';
import { RescueRequestStatus } from '@prisma/client';

export class OperatorRescueRequestQueryDto {
  @IsOptional()
  @IsEnum(RescueRequestStatus)
  status?: RescueRequestStatus;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsInt()
  page?: number;

  @IsOptional()
  @IsInt()
  limit?: number;
}

export class UpdateOperatorRescueStatusDto {
  @IsEnum(RescueRequestStatus)
  status: RescueRequestStatus;
}
