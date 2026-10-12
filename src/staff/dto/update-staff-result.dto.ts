import { UserRole } from '@prisma/client';
import { StaffMemberDto } from './staff-member.dto';

export interface UpdateStaffResult {
  user: StaffMemberDto;
  before: { name?: string | null; role?: UserRole };
  after: { name?: string | null; role?: UserRole };
}
