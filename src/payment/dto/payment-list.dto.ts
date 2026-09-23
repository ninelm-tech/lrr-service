import {
  IsOptional,
  IsEnum,
  IsString,
  IsDateString,
  IsInt,
} from 'class-validator';
import { PaymentType, PaymentStatus } from '@prisma/client';

/**
 * Manual validation, not just the decorators — this app has no global
 * ValidationPipe wired up yet, same gap as AdminRescueRequestQueryDto.
 */
export class PaymentListQueryDto {
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsOptional()
  @IsString()
  rescueRequestId?: string;

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

export class PaymentListCustomerDto {
  id: string;
  phoneNumber: string | null;
}

export class PaymentListOperatorDto {
  id: string;
  businessName: string;
}

/** One ledger row — a single attempt, not a request. See prisma/schema.prisma Payment. */
export class PaymentListItemDto {
  id: string;
  type: PaymentType;
  status: PaymentStatus;
  amount: number;
  currency: string;
  providerFee: number | null;
  netAmount: number | null;
  failureReason: string | null;
  blockReason: string | null;
  checkoutUrl: string | null;
  verifyAttempts: number;
  createdAt: Date;
  settledAt: Date | null;

  rescueRequestId: string;
  customer: PaymentListCustomerDto;
  assignedOperator: PaymentListOperatorDto | null;
  // Only set on PAYOUT rows — see Payment.operatorId in the schema.
  payoutOperator: PaymentListOperatorDto | null;
}

export class PaymentListPaginationDto {
  page: number;
  limit: number;
  total: number;
}

export class PaymentListResponseDto {
  data: PaymentListItemDto[];
  meta: PaymentListPaginationDto;
}

export class PaymentSummaryDto {
  depositCollected: number;
  balanceCollected: number;
  totalCollected: number;
  depositPending: number;
  balancePending: number;
  totalOutstanding: number;
}
