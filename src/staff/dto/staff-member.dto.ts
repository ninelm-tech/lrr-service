import { UserRole } from '@prisma/client';

export interface StaffMemberDto {
  id: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}
