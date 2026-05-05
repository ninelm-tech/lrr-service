import { RescueRequestStatus, IssueType } from '@prisma/client';

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
  customer: CustomerSummaryDto;
  assignedOperator?: OperatorSummaryDto;
  createdAt: Date;
  updatedAt: Date;
}

export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
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
  createdAt: Date;
  updatedAt: Date;
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
