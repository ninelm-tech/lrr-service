import {
  PaymentBlockReason,
  PaymentStatus,
  type Payment,
} from '@prisma/client';

const RETRYABLE_BLOCK_REASONS = new Set<PaymentBlockReason>([
  PaymentBlockReason.NO_BANK_DETAILS,
  PaymentBlockReason.INSUFFICIENT_BALANCE,
  PaymentBlockReason.ACCOUNT_RESTRICTED,
  PaymentBlockReason.PAYOUT_ON_HOLD,
  PaymentBlockReason.INVALID_RECIPIENT,
  PaymentBlockReason.INVALID_AMOUNT,
  PaymentBlockReason.INVALID_REFERENCE,
  PaymentBlockReason.PAYSTACK_VALIDATION,
]);

export function isRetryablePayoutState(
  payment: Pick<Payment, 'status' | 'blockReason'>,
): boolean {
  if (payment.status === PaymentStatus.FAILED) return true;
  return (
    payment.status === PaymentStatus.BLOCKED &&
    payment.blockReason !== null &&
    RETRYABLE_BLOCK_REASONS.has(payment.blockReason)
  );
}
