/**
 * Paystack's own minimum chargeable amount for NGN, in kobo (₦50) —
 * confirmed against Paystack's API reference currency table, 2026-10-25.
 * A deposit below this is not a smaller charge, it's a rejected one: the
 * job would sit stuck at WAITING_FOR_DEPOSIT forever, never payable.
 */
export const MIN_PAYSTACK_CHARGE_KOBO = 5000;

/**
 * The deposit amount actually charged, in kobo. A 0% deposit must never be
 * possible (hotfix, 2026-10-24) — not just unconfigurable going forward,
 * but unconditionally, regardless of why the input percent is 0 (stale
 * data, a frozen snapshot, rounding, a non-numeric value). This is the one
 * place that makes that guarantee; every site that computes or displays a
 * deposit amount must call this rather than reimplementing the formula.
 */
export function computeDepositAmount(
  total: number,
  depositPercent: number,
): number {
  // Math.max(MIN_PAYSTACK_CHARGE_KOBO, NaN) is NaN regardless of which
  // argument carries it — both inputs need guarding, not just percent.
  const safeTotal = Number.isFinite(total) ? total : 0;
  const percent = Number.isFinite(depositPercent) ? depositPercent : 0;
  return Math.max(
    MIN_PAYSTACK_CHARGE_KOBO,
    Math.round((safeTotal * percent) / 100),
  );
}
