import { PaymentBlockReason, PaymentStatus } from '@prisma/client';
import { isRetryablePayoutState } from './payout-retry';

describe('isRetryablePayoutState', () => {
  it('allows terminal failed attempts to start a fresh attempt', () => {
    expect(
      isRetryablePayoutState({
        status: PaymentStatus.FAILED,
        blockReason: null,
      }),
    ).toBe(true);
  });

  it.each([
    PaymentBlockReason.NO_BANK_DETAILS,
    PaymentBlockReason.INSUFFICIENT_BALANCE,
    PaymentBlockReason.ACCOUNT_RESTRICTED,
    PaymentBlockReason.INVALID_RECIPIENT,
  ])('allows retry after the pre-creation block %s is fixed', (blockReason) => {
    expect(
      isRetryablePayoutState({ status: PaymentStatus.BLOCKED, blockReason }),
    ).toBe(true);
  });

  it('does not re-initiate a transfer that is awaiting Paystack OTP', () => {
    expect(
      isRetryablePayoutState({
        status: PaymentStatus.BLOCKED,
        blockReason: PaymentBlockReason.AWAITING_OTP,
      }),
    ).toBe(false);
  });
});
