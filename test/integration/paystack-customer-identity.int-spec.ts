import { PaystackCustomerService } from '../../src/payment/paystack-customer.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, truncateAll } from './factories';

/**
 * The one-Paystack-customer-per-user identity freeze, against a real
 * database. The property that only a real database can demonstrate is the
 * row lock: two concurrent first payments must resolve to the SAME identity
 * and call Paystack exactly once, not each independently create a customer
 * and race a claim afterwards.
 */
describe('Paystack customer identity (integration)', () => {
  let prisma: PrismaService;
  let paystack: { createOrFetchCustomer: jest.Mock };
  let service: PaystackCustomerService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    paystack = {
      createOrFetchCustomer: jest
        .fn()
        .mockResolvedValue({ customer_code: 'CUS_test123', id: 1 }),
    };
    service = new PaystackCustomerService(prisma, paystack as never);
  });

  it('keeps one identity when the user later sets a real email', async () => {
    const user = await createCustomer(prisma); // phone only
    const first = await service.customerFor(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { email: 'ada@example.com' },
    });
    const second = await service.customerFor(user.id);

    expect(second).toEqual(first);
    // The frozen identity email is sent, NOT the new real one.
    expect(second.email).not.toBe('ada@example.com');
    expect(paystack.createOrFetchCustomer).toHaveBeenCalledTimes(1);
  });

  it('calls Paystack once when two payments start at once', async () => {
    // The row lock is what makes this true. A claim after the call would
    // pass the first assertion and fail this one.
    const user = await createCustomer(prisma);
    const [a, b] = await Promise.all([
      service.customerFor(user.id),
      service.customerFor(user.id),
    ]);
    expect(a).toEqual(b);
    expect(paystack.createOrFetchCustomer).toHaveBeenCalledTimes(1);
  });

  it('persists the resolved identity onto the User row', async () => {
    const user = await createCustomer(prisma);

    const { code, email } = await service.customerFor(user.id);

    const reloaded = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(reloaded.paystackCustomerCode).toBe(code);
    expect(reloaded.paystackCustomerEmail).toBe(email);
  });

  it('derives the identity email from phone when the user has no email', async () => {
    const user = await createCustomer(prisma, '+2348012345678');

    const { email } = await service.customerFor(user.id);

    expect(email).toBe('2348012345678@lrr.ng');
    expect(paystack.createOrFetchCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: '2348012345678@lrr.ng' }),
    );
  });
});
