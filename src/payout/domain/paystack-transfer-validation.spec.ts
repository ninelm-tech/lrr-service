import { PaymentBlockReason } from '@prisma/client';
import { classifyTransferValidationRejection } from './paystack-transfer-validation';

describe('classifyTransferValidationRejection', () => {
  it.each([
    [
      'You cannot initiate third party payouts at this time',
      PaymentBlockReason.ACCOUNT_RESTRICTED,
    ],
    [
      'You cannot initiate third party payouts as a starter business',
      PaymentBlockReason.ACCOUNT_RESTRICTED,
    ],
    [
      'Your balance is not enough to fulfill this request',
      PaymentBlockReason.INSUFFICIENT_BALANCE,
    ],
    ['Recipient specified is invalid', PaymentBlockReason.INVALID_RECIPIENT],
    ['Account closed', PaymentBlockReason.INVALID_RECIPIENT],
    [
      'Your reference contains illegal special characters',
      PaymentBlockReason.INVALID_REFERENCE,
    ],
  ])('maps "%s" to %s', (message, expected) => {
    expect(classifyTransferValidationRejection(undefined, message)).toBe(
      expected,
    );
  });

  it('uses a safe generic block for an undocumented validation response', () => {
    expect(
      classifyTransferValidationRejection('new_code', 'New response'),
    ).toBe(PaymentBlockReason.PAYSTACK_VALIDATION);
  });
});
