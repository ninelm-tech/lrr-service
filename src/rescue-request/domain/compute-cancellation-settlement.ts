export interface CancellationSettlement {
  /** Kobo the platform keeps — its proportional fee share of the deposit. */
  feeKeptOut: number;
  /** Kobo returned to the customer via Paystack refund. */
  refundAmount: number;
  /** Kobo paid out to the operator who was already dispatched. */
  payoutAmount: number;
}

/**
 * Splits an already-captured deposit three ways when a request is
 * cancelled after an operator was assigned — see
 * RescueRequestAdminService.resolveCancellationSettlement.
 *
 * The platform's service fee is kept out FIRST, always, regardless of the
 * chosen percentage — cancelling must never be a way to dodge the fee the
 * platform earned by dispatching in the first place. Only its proportional
 * SHARE of the deposit is kept, not the full serviceFeeAmount charged
 * against the whole quote: the deposit itself was collected as the same
 * percentage of (quote + fee) together, so it already contains a
 * proportional slice of the fee, and that's the only part of the fee
 * actually in hand — the rest would only ever have arrived with the
 * balance, which was never charged.
 *
 * customerRefundPercent (0-100) then divides what's LEFT after the fee —
 * not the raw deposit — between the customer and the operator.
 * payoutAmount is deliberately the remainder of that split, not an
 * independently-rounded share of its own, so feeKeptOut + refundAmount +
 * payoutAmount always sums to exactly the deposit, with no stray kobo
 * left unaccounted for.
 */
export function computeCancellationSettlement(
  depositAmount: number,
  serviceFeeAmount: number,
  totalAmount: number,
  customerRefundPercent: number,
): CancellationSettlement {
  const feeKeptOut =
    totalAmount > 0
      ? Math.round((depositAmount * serviceFeeAmount) / totalAmount)
      : 0;
  const splittable = depositAmount - feeKeptOut;

  const refundAmount = Math.round((splittable * customerRefundPercent) / 100);
  return {
    feeKeptOut,
    refundAmount,
    payoutAmount: splittable - refundAmount,
  };
}
