import {
  RescueRequestStatus,
  IssueType,
  VehicleType,
  DispatchOfferStatus,
  RatingDirection,
} from '@prisma/client';

export class CustomerSummaryDto {
  id: string;
  phoneNumber: string;
}

export class CustomerDetailDto {
  id: string;
  phoneNumber: string;
  email?: string;
  name?: string;
}

export class OperatorSummaryDto {
  id: string;
  businessName: string;
}

export class OperatorDetailDto {
  id: string;
  businessName: string;
  phoneNumber: string;
  email?: string;
}

export class RescueRequestListItemDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  balancePaid: boolean;
  depositRefundStatus: 'NONE' | 'ELIGIBLE' | 'PENDING' | 'COMPLETED' | 'FAILED';
  customer: CustomerSummaryDto;
  assignedOperator?: OperatorSummaryDto;
  disputed: boolean;
  disputeRaisedAt?: Date;
  disputeResolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class DispatchOfferAdminDto {
  operatorId: string;
  businessName: string;
  status: DispatchOfferStatus;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: Date;
  respondedAt?: Date;
}

export class DispatchBoardRowDto {
  id: string;
  status: RescueRequestStatus;
  vehicleType?: VehicleType;
  destination?: string;
  round: number;
  createdAt: Date;
  /** Set once the first quote arrives; null while still SEARCHING (phase 1). */
  quoteCollectionDeadline?: Date;
  offers: DispatchOfferAdminDto[];
}

export class RatingSummaryDto {
  id: string;
  direction: RatingDirection;
  score: number;
  comment?: string;
  flagged: boolean;
  flaggedAt?: Date;
  flaggedResolvedAt?: Date;
}

export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  vehicleType?: VehicleType;
  destination?: string;
  mediaLinks: string[];
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  depositAmount?: number;
  depositReference?: string;
  balancePaid: boolean;
  balanceAmount?: number;
  balanceReference?: string;
  customer: CustomerDetailDto;
  assignedOperator?: OperatorDetailDto;
  disputed: boolean;
  disputeRaisedAt?: Date;
  disputeResolvedAt?: Date;
  customerDisputeStatement?: string;
  operatorDisputeStatement?: string;
  disputeResolutionNote?: string;
  disputeOriginalBalanceAmount?: number;
  createdAt: Date;
  updatedAt: Date;
  offers?: DispatchOfferAdminDto[];
  ratings: RatingSummaryDto[];
}

export class PaginationMetaDto {
  page: number;
  limit: number;
  total: number;
}

export class RescueRequestListResponseDto {
  data: RescueRequestListItemDto[];
  meta: PaginationMetaDto;
}

export class RescueRequestDetailResponseDto {
  data: RescueRequestDetailDto;
}
