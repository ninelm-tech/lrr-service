import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

/**
 * The protocol's correctness is its ORDERING, and ordering is only
 * observable against a real database — a mocked Prisma would echo back
 * whatever the service asked for, in whatever order.
 */
describe('PaymentLedgerService (integration)', () => {
  let prisma: PrismaService;
  let ledger: PaymentLedgerService;

  beforeAll(() => {
    prisma = new PrismaService();
    ledger = new PaymentLedgerService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function pending() {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id);
    const payment = await ledger.create({
      rescueRequestId: request.id,
      type: 'DEPOSIT',
      amount: 500_000,
    });
    return { request, payment };
  }

  const reload = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });

  it('creates a row already chaseable by the reconciler', async () => {
    const { payment } = await pending();
    expect(payment.status).toBe('PENDING');
    expect(payment.verifyAfter).not.toBeNull();
  });

  it('formats the reference from the id, keeping the live DEP_ prefix', async () => {
    const { payment } = await pending();
    expect(ledger.referenceFor(payment)).toBe(`DEP_${payment.id}`);
  });

  it('gives refunds no reference — they use merchant_note instead', async () => {
    const { request } = await pending();
    const refund = await ledger.create({
      rescueRequestId: request.id,
      type: 'REFUND',
      amount: 500_000,
    });
    expect(ledger.referenceFor(refund)).toBe('');
  });

  it('pushes verifyAfter into the future when it claims for submission', async () => {
    const { payment } = await pending();
    const before = new Date();

    expect(await ledger.claimForSubmission(payment.id, before)).toBe(true);

    const after = await reload(payment.id);
    expect(after.status).toBe('SUBMITTED');
    // Without this, a concurrent verification could see the row while the
    // POST is still in flight and fail a payment about to succeed.
    expect(after.verifyAfter.getTime()).toBeGreaterThan(before.getTime());
  });

  it('lets exactly one caller win the submission claim', async () => {
    // The reconciler and the request handler can both reach this for the
    // same row. The loser must not call Paystack.
    const { payment } = await pending();

    const results = await Promise.all([
      ledger.claimForSubmission(payment.id, new Date()),
      ledger.claimForSubmission(payment.id, new Date()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to claim a row that is not PENDING', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    expect(await ledger.claimForSubmission(payment.id, new Date())).toBe(false);
  });

  it('claims a terminal state only once — a webhook and a verification race', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    expect(
      await ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' }),
    ).toBe(true);
    // Whichever arrives second finds nothing to claim.
    expect(await ledger.claimTerminal(payment.id, { status: 'FAILED' })).toBe(
      false,
    );

    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.settledAt).not.toBeNull();
  });

  it('records fees alongside the terminal claim', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    await ledger.claimTerminal(
      payment.id,
      { status: 'SUCCEEDED' },
      { providerRef: 'txn:987', providerFee: 7_500, netAmount: 492_500 },
    );

    const after = await reload(payment.id);
    expect(after.providerFee).toBe(7_500);
    expect(after.netAmount).toBe(492_500);
    expect(after.providerRef).toBe('txn:987');
  });

  it('quarantines a second provider success for the same request/type', async () => {
    const { request, payment: first } = await pending();
    await ledger.claimForSubmission(first.id, new Date());
    await ledger.claimTerminal(
      first.id,
      { status: 'SUCCEEDED' },
      { providerRef: 'txn:111' },
    );

    const duplicate = await ledger.create({
      rescueRequestId: request.id,
      type: 'DEPOSIT',
      amount: 500_000,
    });
    await ledger.claimForSubmission(duplicate.id, new Date());

    const claimed = await ledger.claimTerminal(
      duplicate.id,
      { status: 'SUCCEEDED' },
      { providerRef: 'txn:222', providerFee: 7_500, netAmount: 492_500 },
    );

    expect(claimed).toBe(false);

    const after = await reload(duplicate.id);
    expect(after.status).toBe('DUPLICATE_SUCCEEDED');
    expect(after.providerRef).toBe('txn:222');
    expect(after.providerFee).toBe(7_500);
    expect(after.netAmount).toBe(492_500);
    expect(after.settledAt).not.toBeNull();
    expect(after.failureReason).toContain(first.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { category: 'duplicate_payment_success' },
    });
    expect(audit.details).toEqual(
      expect.objectContaining({
        rescueRequestId: request.id,
        type: 'DEPOSIT',
        duplicatePaymentId: duplicate.id,
        existingSucceededPaymentId: first.id,
        duplicateProviderRef: 'txn:222',
        existingProviderRef: 'txn:111',
      }),
    );
  });

  it('records a rejection as FAILED, so a retry is legal', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    await ledger.recordRejection(payment.id, 'insufficient balance');

    const after = await reload(payment.id);
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toBe('insufficient balance');
  });

  it('blocks a row that is waiting on a human, and can unblock it back to SUBMITTED', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    await ledger.recordBlocked(payment.id, 'AWAITING_OTP');
    expect((await reload(payment.id)).status).toBe('BLOCKED');

    // Human action restarts provider processing rather than completing it,
    // so unblocking returns to SUBMITTED — never straight to a terminal.
    await ledger.unblock(payment.id, new Date());
    const after = await reload(payment.id);
    expect(after.status).toBe('SUBMITTED');
    expect(after.blockReason).toBeNull();
  });

  it('backs off exponentially and counts the attempt', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    const first = await reload(payment.id);
    await ledger.backOff(payment.id, new Date());
    const second = await reload(payment.id);

    expect(second.verifyAfter.getTime()).toBeGreaterThan(
      first.verifyAfter.getTime(),
    );
    expect(second.verifyAttempts).toBe(1);
  });

  it('caps the backoff rather than growing without bound', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    const now = new Date();
    for (let i = 0; i < 10; i += 1) await ledger.backOff(payment.id, now);

    const after = await reload(payment.id);
    const gap = after.verifyAfter.getTime() - now.getTime();
    expect(gap).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});
