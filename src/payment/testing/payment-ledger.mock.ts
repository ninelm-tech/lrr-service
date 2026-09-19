import { Payment, PaymentType } from '@prisma/client';
import { REFERENCE_PREFIX } from '../payment.constants';

/**
 * A test double for PaymentLedgerService, for unit specs whose subject
 * happens to move money but whose assertions are about something else.
 *
 * Two behaviours are real rather than stubbed, because tests assert on them:
 * `create` echoes its input back as the row, and `referenceFor` uses the same
 * prefix map as production, so a spec asserting `DEP_<id>` is asserting
 * against the live format rather than a constant restated in the test.
 *
 * The state machine itself is NOT modelled here — every claim succeeds by
 * default. Whether a claim can actually win against a given row is a property
 * of the database, and the integration specs test it there.
 */
export interface PaymentLedgerMock {
  create: jest.Mock;
  claimForSubmission: jest.Mock;
  referenceFor: jest.Mock;
  recordRejection: jest.Mock;
  recordBlocked: jest.Mock;
  unblock: jest.Mock;
  claimTerminal: jest.Mock;
  backOff: jest.Mock;
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
    recordBlocked: jest.fn(),
    // Like claimForSubmission, the default is the winner's path.
    unblock: jest.fn().mockResolvedValue(true),
    claimTerminal: jest.fn().mockResolvedValue(true),
    backOff: jest.fn(),
    ...overrides,
  };
}
