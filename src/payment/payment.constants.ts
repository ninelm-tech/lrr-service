import { PaymentType } from '@prisma/client';

/**
 * Reference prefixes.
 *
 * DEP and BAL are unchanged from the live format — only what follows them
 * changes, from a timestamp-plus-random string to the row id. Renaming
 * working references would cost the recognisability they already have in the
 * Paystack dashboard and buy nothing.
 *
 * Payouts use lowercase, which Paystack documents for transfer references.
 * The current uppercase form has in fact been accepted, so this is alignment
 * with the documented constraint rather than a fix for a live break.
 *
 * Refunds send no reference at all: the API has no such field. They carry
 * Payment.id in `merchant_note` instead — verified to round-trip on
 * 2026-09-13.
 */
export const REFERENCE_PREFIX: Record<PaymentType, string> = {
  DEPOSIT: 'DEP',
  BALANCE: 'BAL',
  PAYOUT: 'payout',
  REFUND: '',
};

/**
 * How long after submission before a row may be verified.
 *
 * Load bearing. Without it a row is eligible the instant the claim commits,
 * so another instance can verify while the POST is still in flight, see
 * "not found", and fail a payment that is about to succeed.
 */
export const INITIAL_VERIFY_DELAY_MS = 60 * 1000;

/** Backoff doubles from the row's age, capped here. */
export const MAX_VERIFY_BACKOFF_MS = 30 * 60 * 1000;

/** After this many verification attempts, stop guessing and tell a human. */
export const MAX_VERIFY_ATTEMPTS = 8;
