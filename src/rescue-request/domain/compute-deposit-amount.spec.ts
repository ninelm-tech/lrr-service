import {
  computeDepositAmount,
  MIN_PAYSTACK_CHARGE_KOBO,
} from './compute-deposit-amount';

describe('computeDepositAmount', () => {
  it('computes the ordinary percentage-based amount when it is above the floor', () => {
    // total 110,000 kobo, 20% -> 22,000, well above the 5,000 kobo floor.
    expect(computeDepositAmount(110_000, 20)).toBe(22_000);
  });

  it("floors a 0% input at Paystack's real minimum, never at 0 or 1", () => {
    expect(computeDepositAmount(100_000, 0)).toBe(MIN_PAYSTACK_CHARGE_KOBO);
    expect(MIN_PAYSTACK_CHARGE_KOBO).toBe(5000);
  });

  it('floors a nonzero percent that rounds to near-zero at the minimum', () => {
    // total 4 kobo, 1% -> Math.round(0.04) = 0 -> floored at 5,000, not 1.
    expect(computeDepositAmount(4, 1)).toBe(MIN_PAYSTACK_CHARGE_KOBO);
  });

  it('treats a NaN percent as 0, never propagating NaN', () => {
    expect(computeDepositAmount(100_000, NaN)).toBe(MIN_PAYSTACK_CHARGE_KOBO);
    expect(Number.isNaN(computeDepositAmount(100_000, NaN))).toBe(false);
  });

  it('treats Infinity as not-finite, never producing an unbounded charge', () => {
    expect(computeDepositAmount(100_000, Infinity)).toBe(
      MIN_PAYSTACK_CHARGE_KOBO,
    );
  });

  it('also treats a non-finite total as 0, never propagating NaN through the other argument (hotfix, 2026-10-25)', () => {
    // Math.max(MIN_PAYSTACK_CHARGE_KOBO, NaN) is NaN regardless of which
    // argument is NaN — the percent side was already guarded; total wasn't.
    expect(computeDepositAmount(NaN, 20)).toBe(MIN_PAYSTACK_CHARGE_KOBO);
    expect(Number.isNaN(computeDepositAmount(NaN, 20))).toBe(false);
    expect(computeDepositAmount(Infinity, 20)).toBe(MIN_PAYSTACK_CHARGE_KOBO);
  });
});
