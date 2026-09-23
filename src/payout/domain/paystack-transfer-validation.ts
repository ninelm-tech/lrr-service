import { PaymentBlockReason } from '@prisma/client';

const includesAny = (value: string, terms: string[]) =>
  terms.some((term) => value.includes(term));

/**
 * Classify a transfer request rejected during Paystack validation. No
 * transfer exists yet, so every result here is retryable with the same
 * payment reference after its underlying condition is fixed.
 */
export function classifyTransferValidationRejection(
  code?: string,
  message?: string,
): PaymentBlockReason {
  const value = `${code ?? ''} ${message ?? ''}`.toLowerCase();

  if (
    includesAny(value, [
      'starter business',
      'third party payout',
      'business_not_registered',
      'account_restricted',
    ])
  ) {
    return PaymentBlockReason.ACCOUNT_RESTRICTED;
  }
  if (includesAny(value, ['payout on hold', 'payout_on_hold'])) {
    return PaymentBlockReason.PAYOUT_ON_HOLD;
  }
  if (includesAny(value, ['balance is not enough', 'insufficient_balance'])) {
    return PaymentBlockReason.INSUFFICIENT_BALANCE;
  }
  if (
    includesAny(value, [
      'invalid recipient',
      'recipient specified is invalid',
      'invalid_recipient',
      "can't make the transfer to this recipient",
      'cannot resolve account',
      'account closed',
      'account number is invalid',
      'bank code is invalid',
    ])
  ) {
    return PaymentBlockReason.INVALID_RECIPIENT;
  }
  if (includesAny(value, ['invalid amount', 'invalid_amount'])) {
    return PaymentBlockReason.INVALID_AMOUNT;
  }
  if (
    includesAny(value, [
      'illegal special characters',
      'invalid entries found',
      'invalid_reference',
    ])
  ) {
    return PaymentBlockReason.INVALID_REFERENCE;
  }
  return PaymentBlockReason.PAYSTACK_VALIDATION;
}
