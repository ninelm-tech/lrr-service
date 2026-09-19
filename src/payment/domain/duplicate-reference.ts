/**
 * A duplicate-reference rejection is evidence the original transfer LANDED —
 * the opposite of a failure. Marking it FAILED would make a fresh row and a
 * fresh reference legal, which is the double-pay this design exists to
 * prevent.
 *
 * Matches the provider code and falls back to the message, so a wording
 * change on Paystack's side cannot silently turn a duplicate into a
 * rejection. Shared between PayoutService's own submission and
 * PaymentVerifyCheck's not-found re-submission — both call initiateTransfer
 * and must read its rejection the same way.
 */
export function isDuplicateReference(r: {
  code?: string;
  message?: string;
}): boolean {
  if (r.code === 'duplicate_reference') return true;
  return /reference.*(already|used|exist)/i.test(r.message ?? '');
}
