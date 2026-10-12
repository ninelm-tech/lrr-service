import { UpdateCustomerDto } from '../dto/update-customer.dto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NormalizedCustomerUpdate =
  | {
      ok: true;
      data: { name?: string; email?: string | null };
      changedFields: Array<'name' | 'email'>;
    }
  | { ok: false; error: string };

/**
 * Validates and normalizes an admin edit of a customer. Pure — no framework
 * or database. Only name and email are editable; anything else on the DTO
 * (notably phoneNumber, the login identity) is ignored.
 */
export function normalizeCustomerUpdate(
  dto: UpdateCustomerDto,
): NormalizedCustomerUpdate {
  const data: { name?: string; email?: string | null } = {};
  const changedFields: Array<'name' | 'email'> = [];

  if (dto.name !== undefined) {
    const name = typeof dto.name === 'string' ? dto.name.trim() : '';
    if (!name || name.length > 100) {
      return { ok: false, error: 'name must be 1-100 characters' };
    }
    data.name = name;
    changedFields.push('name');
  }

  if (dto.email !== undefined) {
    if (dto.email === null) {
      data.email = null;
    } else {
      const email =
        typeof dto.email === 'string' ? dto.email.trim().toLowerCase() : '';
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return { ok: false, error: 'email must be a valid email address' };
      }
      data.email = email;
    }
    changedFields.push('email');
  }

  if (changedFields.length === 0) {
    return { ok: false, error: 'Nothing to update' };
  }
  return { ok: true, data, changedFields };
}
