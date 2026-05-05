import { IsOptional, IsEnum, IsString, IsBoolean, IsDateString, IsNumberString, IsInt } from 'class-validator';
import { RescueRequestStatus, IssueType } from '@prisma/client';

export class AdminRescueRequestQueryDto {
  @IsOptional()
  @IsEnum(RescueRequestStatus)
  status?: RescueRequestStatus;

  @IsOptional()
  @IsEnum(IssueType)
  issueType?: IssueType;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsOptional()
  @IsBoolean()
  depositPaid?: boolean;

  @IsOptional()
  @IsBoolean()
  balancePaid?: boolean;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  page?: number;

  @IsOptional()
  @IsInt()
  limit?: number;
}

export class AssignOperatorDto {
  @IsString()
  operatorId: string;
}

export class UpdateRescueStatusDto {
  @IsEnum(RescueRequestStatus)
  status: RescueRequestStatus;
}

export class CancelRescueRequestDto {
  @IsString()
  reason: string;
}
