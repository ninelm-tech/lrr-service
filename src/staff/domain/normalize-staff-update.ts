import { UserRole } from '@prisma/client';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { EDITABLE_STAFF_ROLES } from './staff-roles';

export type NormalizedStaffUpdate =
  | { ok: true; data: { name?: string; role?: UserRole } }
  | { ok: false; error: string };

/** Validates a staff edit. Pure — no framework or database. */
export function normalizeStaffUpdate(
  dto: UpdateStaffDto,
): NormalizedStaffUpdate {
  const data: { name?: string; role?: UserRole } = {};

  if (dto.role !== undefined) {
    if (!EDITABLE_STAFF_ROLES.includes(dto.role)) {
      return { ok: false, error: 'role must be ADMIN or PRODUCT' };
    }
    data.role = dto.role;
  }
  if (dto.name !== undefined) {
    const name = typeof dto.name === 'string' ? dto.name.trim() : '';
    if (!name || name.length > 100) {
      return { ok: false, error: 'name must be 1-100 characters' };
    }
    data.name = name;
  }

  if (data.name === undefined && data.role === undefined) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, data };
}
