import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackInitializeResult } from '../../src/integrations/paystack/dto/paystack-outcome.dto';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * The deposit call site, end to end, against a real database.
 *
 * The unit specs already cover which branch runs for which outcome. What
 * only a real database can show is the ORDERING the protocol depends on:
 * that the row exists and is already SUBMITTED at the moment Paystack is
 * called, and that the row a failed attempt leaves behind is one the
 * reconciler can still act on correctly.
 */
describe('Deposit submission protocol (integration)', () => {
  let prisma: PrismaService;
  let service: RescueRequestAdminService;
  let initializePayment: jest.Mock;
  let twilio: { sendWhatsAppMessage: jest.Mock };

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    initializePayment = jest.fn();
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };

    service = new RescueRequestAdminService(
      prisma,
      { initializePayment } as never,
      twilio as never,
      {
        getConfig: jest
          .fn()
          .mockResolvedValue({ serviceFeePercent: 10, depositPercent: 20 }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { clear: jest.fn() } as never,
      new PaymentLedgerService(prisma),
      {
        customerFor: jest
          .fn()
          .mockResolvedValue({ code: 'cus_test', email: 'customer@lrr.ng' }),
      } as never,
      {} as never,
    );
  });

  const ok = (
    url = 'https://paystack.test/pay/xyz',
  ): PaystackInitializeResult => ({
    outcome: 'ok',
    data: { authorization_url: url, access_code: 'acc_1', reference: 'ref' },
  });

  async function dispatchingRequest() {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    return { operator, request };
  }

  const assign = (requestId: string, operatorId: string) =>
    service.assignOperator(requestId, { operatorId, priceKobo: 100_000 });

  const onlyPayment = () => prisma.payment.findFirstOrThrow();

  it('has already committed the row as SUBMITTED before it calls Paystack', async () => {
    const { operator, request } = await dispatchingRequest();

    // Read the row from a separate query INSIDE the call. If the write were
    // still in an open transaction, or ordered after the call, this would
    // see nothing — which is the bug the protocol exists to prevent.
    let seenDuringCall: { status: string; checkoutUrl: string | null } | null =
      null;
    initializePayment.mockImplementation(async () => {
      const row = await prisma.payment.findFirstOrThrow();
      seenDuringCall = { status: row.status, checkoutUrl: row.checkoutUrl };
      return ok();
    });

    await assign(request.id, operator.id);

    expect(seenDuringCall).toEqual({ status: 'SUBMITTED', checkoutUrl: null });
  });

  it('sends Paystack the row id as the reference, so a webhook can find it', async () => {
    const { operator, request } = await dispatchingRequest();
    initializePayment.mockResolvedValue(ok());

    await assign(request.id, operator.id);

    const payment = await onlyPayment();
    expect(initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: `DEP_${payment.id}`,
        amount: 22_000,
      }),
    );
  });

  it('pushes verifyAfter beyond the call, so nothing verifies a request in flight', async () => {
    const { operator, request } = await dispatchingRequest();
    initializePayment.mockResolvedValue(ok());
    const before = new Date();

    await assign(request.id, operator.id);

    const payment = await onlyPayment();
    expect(payment.verifyAfter.getTime()).toBeGreaterThan(before.getTime());
  });

  it('stores the checkout URL before the link is sent to the customer', async () => {
    const { operator, request } = await dispatchingRequest();
    initializePayment.mockResolvedValue(ok('https://paystack.test/pay/abc'));

    // Whatever the row says when Twilio is called must already include the
    // URL: after this point the customer can pay, and recovery must never
    // fail the attempt.
    //
    // The sends are fire-and-forget (`void`), so awaiting the mock proves
    // nothing. Instead the mock starts the read synchronously, at the moment
    // of the send, and the test awaits that read afterwards.
    let readAtSendTime: Promise<string | null> | undefined;
    let bodyAtSendTime: string | undefined;
    twilio.sendWhatsAppMessage.mockImplementation(
      (_to: string, body: string) => {
        if (!readAtSendTime && body.includes('paystack.test')) {
          bodyAtSendTime = body;
          readAtSendTime = prisma.payment
            .findFirstOrThrow()
            .then((p) => p.checkoutUrl);
        }
        return Promise.resolve();
      },
    );

    await assign(request.id, operator.id);

    expect(bodyAtSendTime).toContain('https://paystack.test/pay/abc');
    expect(await readAtSendTime).toBe('https://paystack.test/pay/abc');
  });

  it('fails the row on a definitive rejection, which frees the index for a retry', async () => {
    const { operator, request } = await dispatchingRequest();
    initializePayment.mockResolvedValue({
      outcome: 'rejected',
      code: 'invalid_params',
      message: 'Invalid amount',
    });

    await expect(assign(request.id, operator.id)).rejects.toThrow(
      `Couldn't generate a payment link`,
    );

    const payment = await onlyPayment();
    expect(payment.status).toBe('FAILED');
    expect(payment.failureReason).toBe('Invalid amount');

    // The real proof that a retry is legal: the partial unique index only
    // covers in-flight rows, so a second attempt inserts rather than throwing.
    initializePayment.mockResolvedValue(ok());
    await assign(request.id, operator.id);
    expect(await prisma.payment.count()).toBe(2);
  });

  it('blocks a second deposit even when the first is only PENDING', async () => {
    // The claim is what moves a row to SUBMITTED, but the index covers
    // PENDING too — a row that was created and then abandoned before its
    // claim still represents an attempt nobody has resolved.
    const { operator, request } = await dispatchingRequest();
    await new PaymentLedgerService(prisma).create({
      rescueRequestId: request.id,
      type: 'DEPOSIT',
      amount: 22_000,
    });
    initializePayment.mockResolvedValue(ok());

    await expect(assign(request.id, operator.id)).rejects.toThrow(
      'A deposit is already in flight',
    );
    expect(initializePayment).not.toHaveBeenCalled();
    expect(await prisma.dispatchOffer.count()).toBe(0);
  });

  it('leaves an ambiguous attempt SUBMITTED with no URL, and blocks a second attempt', async () => {
    const { operator, request } = await dispatchingRequest();
    initializePayment.mockResolvedValue({
      outcome: 'ambiguous',
      message: 'gateway timeout',
    });

    await expect(assign(request.id, operator.id)).rejects.toThrow(
      'Do not retry yet',
    );

    const payment = await onlyPayment();
    // SUBMITTED + null URL is the pair that tells recovery a transaction may
    // exist at Paystack but no link ever reached the customer.
    expect(payment.status).toBe('SUBMITTED');
    expect(payment.checkoutUrl).toBeNull();
    expect(payment.failureReason).toBeNull();

    // And the index enforces the rule rather than trusting the caller: the
    // status checks in assignOperator read the request without claiming it,
    // so a retry gets all the way to the insert and the database refuses it.
    initializePayment.mockResolvedValue(ok());
    await expect(assign(request.id, operator.id)).rejects.toThrow(
      'A deposit is already in flight',
    );
    expect(await prisma.payment.count()).toBe(1);
    // The blocked retry must not have reached Paystack at all.
    expect(initializePayment).toHaveBeenCalledTimes(1);
    // Exactly 1, not 0: assignOperator now creates the SELECTED_PENDING_PAYMENT
    // offer durably inside the same transaction as the assignment claim,
    // before Paystack is ever called (account-deletion plan Task 9b — offer
    // creation moved earlier so no HTTP call happens before durable
    // assignment). An ambiguous Paystack response doesn't undo that
    // assignment, only the deposit-link status is unknown — same as the
    // Payment row above, this offer is deliberately left in place for
    // DepositExpiryCheck to eventually resolve, not rolled back here. The
    // blocked retry's own attempted offer IS correctly rolled back (it's
    // inside the same transaction as the P2002-failing payment insert), so
    // the count stays at 1 rather than growing to 2.
    expect(await prisma.dispatchOffer.count()).toBe(1);
  });
});
