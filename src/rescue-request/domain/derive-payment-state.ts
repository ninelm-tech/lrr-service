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

/** A refund attempt that still might land, or already has. */
const ACTIVE_OR_SUCCEEDED_REFUND_STATUSES: PaymentStatus[] = [
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
 * The admin list's refundEligible=true filter, as a Prisma relation-filter
 * fragment: a succeeded DEPOSIT exists, and no active-or-succeeded REFUND
 * does. Callers still add `status: CANCELLED` themselves alongside this,
 * since that half is a plain scalar filter.
 */
export function refundEligiblePaymentsFilter() {
  return {
    some: { type: PaymentType.DEPOSIT, status: PaymentStatus.SUCCEEDED },
    none: {
      type: PaymentType.REFUND,
      status: { in: ACTIVE_OR_SUCCEEDED_REFUND_STATUSES },
    },
  };
}
