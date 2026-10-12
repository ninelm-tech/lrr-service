import { UserRole } from '@prisma/client';

/** Internal platform users — what the Team page lists. */
export const STAFF_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  UserRole.PRODUCT,
];

/**
 * Roles that may be assigned or edited through the staff endpoint.
 * SUPER_ADMIN is deliberately excluded: it can't be granted, revoked or
 * edited here, so the platform can never end up without one by this path.
 */
export const EDITABLE_STAFF_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.PRODUCT,
];
