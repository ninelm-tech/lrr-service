import {
  PaymentStatus,
  PaymentType,
  RescueRequestStatus,
} from '@prisma/client';

/**
 * The columns this replaces (depositPaid, balancePaid, depositRefundStatus,
 * depositRefundId) were dropped once Payment became the only record of
 * money movement — see the payment-model plan, Task 11. These functions are
 * how every reader gets the same answer back, computed instead of stored.
 *
 * All take the minimal Payment shape a query actually needs, so a caller
 * can `select` just `{ type, status }` rather than loading full rows.
 */
type PaymentForDerivation = { type: PaymentType; status: PaymentStatus };

/** depositPaid / balancePaid: true once a SUCCEEDED payment of that type exists. */
export function hasSucceededPayment(
  payments: PaymentForDerivation[],
  type: PaymentType,
): boolean {
  return payments.some(
    (p) => p.type === type && p.status === PaymentStatus.SUCCEEDED,
  );
}

/** A refund (or payout) attempt that still might land, or already has. */
export const ACTIVE_OR_SUCCEEDED_REFUND_STATUSES: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.SUBMITTED,
  PaymentStatus.BLOCKED,
  PaymentStatus.SUCCEEDED,
];

/**
 * The old RefundStatus enum's exact values, computed instead of stored.
 *
 * NONE means "not a late-payment case" — the request isn't CANCELLED with a
 * paid deposit at all, so refund eligibility never entered the picture.
 * ELIGIBLE/PENDING/COMPLETED/FAILED are then read off whatever REFUND
 * attempts exist. A FAILED refund attempt does NOT count as active — one row
 * per attempt means a failed one stays on the request forever by design, and
 * treating it as a permanent claim would strand a request an admin most
 * needs to retry. See the plan's Task 11, Step 1.
 *
 * A PAYOUT row also counts as COMPLETED, even with no REFUND row at all —
 * resolveCancellationSettlement can pay the operator the full deposit
 * (customerRefundPercent: 0) without ever creating a REFUND row. Without
 * this check, this deposit would still read as ELIGIBLE and refundDeposit
 * would refund it a second time on top of the payout already sent.
 */
export function deriveRefundStatus(
  requestStatus: RescueRequestStatus,
  payments: PaymentForDerivation[],
): 'NONE' | 'ELIGIBLE' | 'PENDING' | 'COMPLETED' | 'FAILED' {
  if (
    requestStatus !== RescueRequestStatus.CANCELLED ||
    !hasSucceededPayment(payments, PaymentType.DEPOSIT)
  ) {
    return 'NONE';
  }

  if (
    payments.some(
      (p) =>
        p.type === PaymentType.PAYOUT &&
        ACTIVE_OR_SUCCEEDED_REFUND_STATUSES.includes(p.status),
    )
  ) {
    return 'COMPLETED';
  }

  const refunds = payments.filter((p) => p.type === PaymentType.REFUND);
  if (refunds.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
    return 'COMPLETED';
  }
  if (
    refunds.some((p) =>
      (
        [
          PaymentStatus.PENDING,
          PaymentStatus.SUBMITTED,
          PaymentStatus.BLOCKED,
        ] as PaymentStatus[]
      ).includes(p.status),
    )
  ) {
    return 'PENDING';
  }
  if (refunds.some((p) => p.status === PaymentStatus.FAILED)) {
    return 'FAILED';
  }
  return 'ELIGIBLE';
}

/**
 * Eligibility for the operator-payout-split cancellation settlement — see
 * RescueRequestAdminService.resolveCancellationSettlement. Distinct from
 * deriveRefundStatus's plain always-100%-to-customer refund: this only
 * applies once an operator was actually assigned (there's someone to pay).
 *
 * The PRIMARY "already done" signal is cancellationSettledAt, NOT the
 * REFUND/PAYOUT Payment rows the way deriveRefundStatus reads REFUND rows —
 * a REFUND and a PAYOUT are different Payment `type`s, so they claim
 * separate slots in the in-flight-uniqueness index and would NOT stop each
 * other from both being submitted by two concurrent callers (e.g. one
 * submitting 100% — refund only — and another submitting 0% — payout only —
 * on the same request at once: neither's Payment row exists yet at either's
 * read time, so a Payment-based check would let both through).
 * cancellationSettledAt is claimed atomically, once, before either leg ever
 * runs, so it is the signal that actually closes that race.
 *
 * A REFUND row also counts as SETTLED, even with cancellationSettledAt
 * still null — the plain refundDeposit endpoint may have already refunded
 * this deposit in full before anyone ever tried this feature. Without this
 * check, resolveCancellationSettlement would refund it again.
 */
export function deriveCancellationSettlementEligibility(
  requestStatus: RescueRequestStatus,
  assignedOperatorId: string | null,
  cancellationSettledAt: Date | null,
  payments: PaymentForDerivation[],
): 'NONE' | 'ELIGIBLE' | 'SETTLED' {
  if (
    requestStatus !== RescueRequestStatus.CANCELLED ||
    !assignedOperatorId ||
    !hasSucceededPayment(payments, PaymentType.DEPOSIT)
  ) {
    return 'NONE';
  }

  if (cancellationSettledAt) return 'SETTLED';

  const alreadyRefunded = payments.some(
    (p) =>
      p.type === PaymentType.REFUND &&
      ACTIVE_OR_SUCCEEDED_REFUND_STATUSES.includes(p.status),
  );
  return alreadyRefunded ? 'SETTLED' : 'ELIGIBLE';
}

/**
 * The admin list's refundEligible=true filter, as a Prisma relation-filter
 * fragment: a succeeded DEPOSIT exists, and no active-or-succeeded REFUND
 * OR PAYOUT does — same "already handled" set deriveRefundStatus checks,
 * including the PAYOUT-only case (see its own doc comment). Callers still
 * add `status: CANCELLED` themselves alongside this, since that half is a
 * plain scalar filter.
 */
export function refundEligiblePaymentsFilter() {
  return {
    some: { type: PaymentType.DEPOSIT, status: PaymentStatus.SUCCEEDED },
    none: {
      OR: [
        {
          type: PaymentType.REFUND,
          status: { in: ACTIVE_OR_SUCCEEDED_REFUND_STATUSES },
        },
        {
          type: PaymentType.PAYOUT,
          status: { in: ACTIVE_OR_SUCCEEDED_REFUND_STATUSES },
        },
      ],
    },
  };
}
