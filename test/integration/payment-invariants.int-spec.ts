import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

/**
 * The two partial unique indexes are the guarantee this whole design exists
 * to provide, so they are tested against real Postgres. A mocked Prisma
 * cannot demonstrate a partial index — it would only echo back the query
 * object it was handed.
 */
describe('Payment invariants (integration)', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function request() {
    const customer = await createCustomer(prisma);
    return createRequest(prisma, customer.id);
  }

  const attempt = (
    rescueRequestId: string,
    over: Record<string, unknown> = {},
  ) => ({
    rescueRequestId,
    type: 'DEPOSIT' as const,
    amount: 500_000,
    ...over,
  });

  it('permits only one in-flight attempt per request and type', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'SUBMITTED' }) }),
    ).rejects.toThrow();
  });

  it('counts BLOCKED as in flight — it already exists at Paystack', async () => {
    // Waiting on a human is still waiting: the money movement exists
    // provider-side, so a second attempt would duplicate it.
    const r = await request();
    await prisma.payment.create({
      data: attempt(r.id, { status: 'BLOCKED', blockReason: 'AWAITING_OTP' }),
    });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) }),
    ).rejects.toThrow();
  });

  it('permits a fresh attempt after a failed one — that is how retry works', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'FAILED' }) });

    const retry = await prisma.payment.create({
      data: attempt(r.id, { status: 'PENDING' }),
    });
    expect(retry.id).toBeDefined();
  });

  it('permits only one success per request and type', async () => {
    const r = await request();
    await prisma.payment.create({
      data: attempt(r.id, { status: 'SUCCEEDED' }),
    });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'SUCCEEDED' }) }),
    ).rejects.toThrow();
  });

  it('does not confuse types — a deposit and a payout coexist', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) });

    const payout = await prisma.payment.create({
      data: attempt(r.id, { type: 'PAYOUT', status: 'PENDING' }),
    });
    expect(payout.id).toBeDefined();
  });

  it('namespaces providerRef so a transaction id and a refund id can share a number', async () => {
    // Paystack's transaction and refund ids are independent sequences, so
    // without the prefix these two would collide on the unique index.
    const a = await request();
    const b = await request();
    await prisma.payment.create({
      data: attempt(a.id, { providerRef: 'txn:123' }),
    });

    const other = await prisma.payment.create({
      data: attempt(b.id, { type: 'REFUND', providerRef: 'refund:123' }),
    });
    expect(other.providerRef).toBe('refund:123');
  });

  it('gives every new row a verifyAfter, so the reconciler can always find it', async () => {
    const r = await request();
    const p = await prisma.payment.create({ data: attempt(r.id) });

    expect(p.verifyAfter).not.toBeNull();
    expect(p.verifyAttempts).toBe(0);
    // The pair (SUBMITTED, checkoutUrl null) is what tells recovery no link
    // ever reached the customer, so it must start null rather than empty.
    expect(p.checkoutUrl).toBeNull();
  });
});
