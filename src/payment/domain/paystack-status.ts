import { PaymentBlockReason, PaymentStatus } from '@prisma/client';

export interface MappedStatus {
  status: PaymentStatus;
  blockReason?: PaymentBlockReason;
}

/**
 * Provider status → our state.
 *
 * Observed against the live test integration on 2026-09-12/13 rather than
 * taken from documentation. See
 * docs/superpowers/specs/2026-09-12-payment-model-design.md.
 *
 * THE DEFAULT MATTERS AS MUCH AS THE CASES. An unrecognised status must never
 * be guessed into a terminal state: staying SUBMITTED keeps the row polled
 * and visible to staff, which is the safe direction to be wrong in. A wrong
 * SUCCEEDED marks money as moved that has not, and a wrong FAILED makes a
 * fresh attempt legal for a payment that may already exist at Paystack.
 */

/**
 * `abandoned` is TERMINAL for a transfer: it is what one becomes when it is
 * initiated and never finalised — the OTP path, left unanswered. Nothing
 * moved (`transferred_at` null, `fee_charged` 0) and it will not resume, so
 * FAILED is correct and a retry may legitimately create a fresh attempt.
 */
export function mapTransferStatus(status: string): MappedStatus {
  switch (status) {
    case 'success':
      return { status: PaymentStatus.SUCCEEDED };
    case 'failed':
      return { status: PaymentStatus.FAILED };
    case 'reversed':
      return { status: PaymentStatus.REVERSED };
    case 'abandoned':
      return { status: PaymentStatus.FAILED };
    case 'otp':
      return {
        status: PaymentStatus.BLOCKED,
        blockReason: PaymentBlockReason.AWAITING_OTP,
      };
    default:
      return { status: PaymentStatus.SUBMITTED };
  }
}

/**
 * `abandoned` is NOT terminal for a collection, unlike for a transfer. It
 * means the customer has not paid yet — the checkout link may still be
 * sitting in their WhatsApp thread, and they can still use it. Failing here
 * would write off a payment they are still able to make. The deposit window
 * expiring is what ends an unpaid collection, not this mapping.
 */
export function mapTransactionStatus(status: string): MappedStatus {
  switch (status) {
    case 'success':
      return { status: PaymentStatus.SUCCEEDED };
    case 'failed':
      return { status: PaymentStatus.FAILED };
    case 'reversed':
      return { status: PaymentStatus.REVERSED };
    default:
      return { status: PaymentStatus.SUBMITTED };
  }
}

/**
 * `needs-attention` is Paystack waiting on the customer's bank details.
 * Polling will never resolve it, so it is BLOCKED and surfaced to staff
 * rather than left in SUBMITTED to be chased forever.
 */
export function mapRefundStatus(status: string): MappedStatus {
  switch (status) {
    case 'processed':
      return { status: PaymentStatus.SUCCEEDED };
    case 'failed':
      return { status: PaymentStatus.FAILED };
    case 'needs-attention':
      return {
        status: PaymentStatus.BLOCKED,
        blockReason: PaymentBlockReason.NEEDS_CUSTOMER_DETAILS,
      };
    default:
      return { status: PaymentStatus.SUBMITTED };
  }
}
