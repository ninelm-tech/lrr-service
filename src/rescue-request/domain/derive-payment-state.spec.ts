import {
  PaymentStatus,
  PaymentType,
  RescueRequestStatus,
} from '@prisma/client';
import {
  deriveCancellationSettlementEligibility,
  deriveRefundStatus,
} from './derive-payment-state';

describe('deriveCancellationSettlementEligibility', () => {
  const succeededDeposit = {
    type: PaymentType.DEPOSIT,
    status: PaymentStatus.SUCCEEDED,
  };

  it('is NONE when the request is not CANCELLED', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.IN_PROGRESS,
        'operator-1',
        null,
        [succeededDeposit],
      ),
    ).toBe('NONE');
  });

  it('is NONE when no operator was ever assigned — nothing to pay out, use the plain refund instead', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        null,
        null,
        [succeededDeposit],
      ),
    ).toBe('NONE');
  });

  it('is NONE when the deposit was never actually paid', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        null,
        [],
      ),
    ).toBe('NONE');
  });

  it('is ELIGIBLE once cancelled with a paid deposit and an assigned operator, and nothing has been settled yet', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        null,
        [succeededDeposit],
      ),
    ).toBe('ELIGIBLE');
  });

  // cancellationSettledAt is the concurrency-safety signal for two
  // concurrent resolveCancellationSettlement calls (a REFUND and a PAYOUT
  // claim separate in-flight-index slots and wouldn't stop each other).
  it('is SETTLED once cancellationSettledAt is set, regardless of what the individual Payment rows say', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        new Date('2026-09-22T00:00:00Z'),
        [succeededDeposit],
      ),
    ).toBe('SETTLED');
  });

  // cancellationSettledAt is null here — this is the OTHER endpoint
  // entirely: the plain refundDeposit already refunded this request
  // (a real REFUND row exists) before anyone ever tried
  // resolveCancellationSettlement. Without this check, the settlement
  // would refund the deposit a second time on top of that.
  it('is SETTLED when a REFUND already exists from the plain refundDeposit endpoint, even though cancellationSettledAt is still null', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        null,
        [
          succeededDeposit,
          { type: PaymentType.REFUND, status: PaymentStatus.SUCCEEDED },
        ],
      ),
    ).toBe('SETTLED');
  });

  it('is SETTLED even while that REFUND is only SUBMITTED — not yet landed, but already claimed by refundDeposit', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        null,
        [
          succeededDeposit,
          { type: PaymentType.REFUND, status: PaymentStatus.SUBMITTED },
        ],
      ),
    ).toBe('SETTLED');
  });

  it('is ELIGIBLE when the only REFUND on record FAILED — nothing actually moved, so this is still open', () => {
    expect(
      deriveCancellationSettlementEligibility(
        RescueRequestStatus.CANCELLED,
        'operator-1',
        null,
        [
          succeededDeposit,
          { type: PaymentType.REFUND, status: PaymentStatus.FAILED },
        ],
      ),
    ).toBe('ELIGIBLE');
  });
});

describe('deriveRefundStatus', () => {
  const succeededDeposit = {
    type: PaymentType.DEPOSIT,
    status: PaymentStatus.SUCCEEDED,
  };

  it('is NONE when the request is not CANCELLED', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.IN_PROGRESS, [succeededDeposit]),
    ).toBe('NONE');
  });

  it('is NONE when the deposit was never actually paid', () => {
    expect(deriveRefundStatus(RescueRequestStatus.CANCELLED, [])).toBe('NONE');
  });

  it('is ELIGIBLE once cancelled with a paid deposit and nothing has moved yet', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.CANCELLED, [succeededDeposit]),
    ).toBe('ELIGIBLE');
  });

  it('is COMPLETED once a REFUND has SUCCEEDED', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.CANCELLED, [
        succeededDeposit,
        { type: PaymentType.REFUND, status: PaymentStatus.SUCCEEDED },
      ]),
    ).toBe('COMPLETED');
  });

  it('is FAILED when the only REFUND attempt failed — retryable', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.CANCELLED, [
        succeededDeposit,
        { type: PaymentType.REFUND, status: PaymentStatus.FAILED },
      ]),
    ).toBe('FAILED');
  });

  // resolveCancellationSettlement can pay the operator the FULL deposit
  // (customerRefundPercent: 0) with NO accompanying REFUND row at all —
  // without this check, refundDeposit would see "no REFUND row" and
  // refund the full deposit again on top of the payout already sent.
  it('is COMPLETED when a PAYOUT already exists — a cancellation settlement already resolved this deposit, even with no REFUND row', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.CANCELLED, [
        succeededDeposit,
        { type: PaymentType.PAYOUT, status: PaymentStatus.SUCCEEDED },
      ]),
    ).toBe('COMPLETED');
  });

  it('is COMPLETED even while that PAYOUT is only SUBMITTED — not yet landed, but already claimed', () => {
    expect(
      deriveRefundStatus(RescueRequestStatus.CANCELLED, [
        succeededDeposit,
        { type: PaymentType.PAYOUT, status: PaymentStatus.SUBMITTED },
      ]),
    ).toBe('COMPLETED');
  });
});
