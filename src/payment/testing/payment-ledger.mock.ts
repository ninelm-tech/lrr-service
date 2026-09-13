import { Payment, PaymentType } from '@prisma/client';
import { REFERENCE_PREFIX } from '../payment.constants';

/**
 * A test double for PaymentLedgerService, for unit specs whose subject
 * happens to move money but whose assertions are about something else.
 *
 * It covers only the four methods the collection flows actually call. A mock
 * that also stubs claimTerminal/unblock/backOff would imply those paths are
 * exercised here; they are not — they belong to the webhook and the verify
 * check, which are tested against a real database.
 *
 * Two behaviours are real rather than stubbed, because tests assert on them:
 * `create` echoes its input back as the row, and `referenceFor` uses the same
 * prefix map as production, so a spec asserting `DEP_<id>` is asserting
 * against the live format rather than a constant restated in the test.
 */
export interface PaymentLedgerMock {
  create: jest.Mock;
  claimForSubmission: jest.Mock;
  referenceFor: jest.Mock;
  recordRejection: jest.Mock;
}

export function createPaymentLedgerMock(
  overrides: Partial<PaymentLedgerMock> = {},
): PaymentLedgerMock {
  let seq = 0;

  return {
    create: jest.fn(
      (input: { rescueRequestId: string; type: PaymentType; amount: number }) =>
        Promise.resolve({
          id: `pay-${(seq += 1)}`,
          rescueRequestId: input.rescueRequestId,
          type: input.type,
          amount: input.amount,
          status: 'PENDING',
        } as unknown as Payment),
    ),
    // The default is the winner's path. A spec that needs the loser's branch
    // overrides this with false.
    claimForSubmission: jest.fn().mockResolvedValue(true),
    referenceFor: jest.fn((payment: Pick<Payment, 'id' | 'type'>) => {
      const prefix = REFERENCE_PREFIX[payment.type];
      return prefix ? `${prefix}_${payment.id}` : '';
    }),
    recordRejection: jest.fn(),
    ...overrides,
  };
}
