import { UserRole } from '@prisma/client';

/**
 * Platform staff who may act on any operator without being a member of it.
 * The default for every operator mutation.
 */
export const OPERATOR_ADMIN_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

/**
 * Staff who may do day-to-day operator onboarding: edit the profile, set
 * payout bank details, toggle availability. PRODUCT is deliberately only
 * here — never in OPERATOR_ADMIN_ROLES — so verifying/suspending, member
 * management, and deletes stay admin-only.
 */
export const OPERATOR_ONBOARDING_ROLES: readonly UserRole[] = [
  ...OPERATOR_ADMIN_ROLES,
  UserRole.PRODUCT,
];

export function hasRole(role: string, allowed: readonly UserRole[]): boolean {
  return allowed.includes(role as UserRole);
}
