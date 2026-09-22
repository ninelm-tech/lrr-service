import { computeCancellationSettlement } from './compute-cancellation-settlement';

describe('computeCancellationSettlement', () => {
  it("keeps the platform's proportional fee share, then gives the customer a full refund of the rest at 100%", () => {
    // Quote ₦50,000, 15% fee (₦7,500), 15% deposit → total ₦57,500,
    // deposit ₦8,625. The fee's own share of that deposit is
    // 8625 * 7500/57500 = ₦1,125 — always kept, regardless of percentage.
    expect(computeCancellationSettlement(8625, 7500, 57500, 100)).toEqual({
      feeKeptOut: 1125,
      refundAmount: 7500,
      payoutAmount: 0,
    });
  });

  it('gives the operator the whole splittable remainder and the customer nothing at 0% — the fee is still kept out first', () => {
    expect(computeCancellationSettlement(8625, 7500, 57500, 0)).toEqual({
      feeKeptOut: 1125,
      refundAmount: 0,
      payoutAmount: 7500,
    });
  });

  it("splits the fee-adjusted remainder at a partial percentage — the user's own worked example", () => {
    expect(computeCancellationSettlement(8625, 7500, 57500, 70)).toEqual({
      feeKeptOut: 1125,
      refundAmount: 5250,
      payoutAmount: 2250,
    });
  });

  it('keeps nothing out when there was no service fee', () => {
    expect(computeCancellationSettlement(500000, 0, 550000, 70)).toEqual({
      feeKeptOut: 0,
      refundAmount: 350000,
      payoutAmount: 150000,
    });
  });

  it('rounds the kept fee and the refund independently, deriving the payout as the exact remainder — the three always sum to exactly the deposit', () => {
    const result = computeCancellationSettlement(100001, 1, 3, 33);
    expect(result.feeKeptOut + result.refundAmount + result.payoutAmount).toBe(
      100001,
    );
    expect(result).toEqual({
      feeKeptOut: 33334,
      refundAmount: 22000,
      payoutAmount: 44667,
    });
  });

  it('treats a missing/zero total as no fee to keep — avoids dividing by zero', () => {
    expect(computeCancellationSettlement(500000, 0, 0, 70)).toEqual({
      feeKeptOut: 0,
      refundAmount: 350000,
      payoutAmount: 150000,
    });
  });
});
