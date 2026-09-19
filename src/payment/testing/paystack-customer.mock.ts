import { PaystackCustomerIdentity } from '../paystack-customer.service';

/**
 * A test double for PaystackCustomerService, for unit specs whose subject
 * calls customerFor() but whose assertions are about something else. The
 * default echoes a deterministic identity back so specs that don't care
 * about the exact email still get a stable value to assert against.
 */
export interface PaystackCustomerServiceMock {
  customerFor: jest.Mock;
}

export function createPaystackCustomerServiceMock(
  overrides: Partial<PaystackCustomerServiceMock> = {},
): PaystackCustomerServiceMock {
  return {
    customerFor: jest.fn(
      (userId: string): Promise<PaystackCustomerIdentity> =>
        Promise.resolve({
          code: `cus_${userId}`,
          email: `${userId}@lrr.ng`,
        }),
    ),
    ...overrides,
  };
}
