import { PaymentService } from '../../src/payment/payment.service';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackWebhookBody } from '../../src/payment/dto/paystack-webhook.dto';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * Webhooks, against a real database.
 *
 * This is the only path that writes SUCCEEDED, so it is the first point at
 * which a payment is ever finished. The properties that matter are that it
 * finds the right row from three different kinds of identifier, and that it
 * settles exactly once when it races verification.
 */
describe('Payment webhooks (integration)', () => {
  let prisma: PrismaService;
  let ledger: PaymentLedgerService;
  let service: PaymentService;
  let paymentEvents: {
    handleDepositPaymentConfirmed: jest.Mock;
    handleBalancePaymentConfirmed: jest.Mock;
  };
  let payout: { confirmTransferOutcome: jest.Mock };

  beforeAll(() => {
    prisma = new PrismaService();
    ledger = new PaymentLedgerService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    paymentEvents = {
      handleDepositPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
      handleBalancePaymentConfirmed: jest.fn().mockResolvedValue(undefined),
    };
    payout = { confirmTransferOutcome: jest.fn().mockResolvedValue(undefined) };

    service = new PaymentService(
      { get: () => undefined } as never,
      paymentEvents as never,
      payout as never,
      prisma,
      ledger,
    );
  });

  /** A payment already SUBMITTED, which is the state a webhook arrives into. */
  async function submitted(type: 'DEPOSIT' | 'BALANCE' | 'PAYOUT' | 'REFUND') {
    const customer = await createCustomer(prisma);
    const operator = type === 'PAYOUT' ? await createOperator(prisma) : null;
    const request = await createRequest(prisma, customer.id, {
      depositRefundStatus: type === 'REFUND' ? 'PENDING' : undefined,
    });
    const payment = await ledger.create({
      rescueRequestId: request.id,
      type,
      amount: 500_000,
      operatorId: operator?.id,
    });
    await ledger.claimForSubmission(payment.id, new Date());
    return { request, payment };
  }

  const send = (body: PaystackWebhookBody) =>
    service.handlePaystackWebhook(body);

  const reload = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });

  it('settles a deposit and records the transaction id refund recovery needs', async () => {
    const { payment } = await submitted('DEPOSIT');

    await send({
      event: 'charge.success',
      data: {
        reference: `DEP_${payment.id}`,
        id: 778899,
        amount: 500_000,
        fees: 7_500,
        metadata: { type: 'deposit' },
      },
    });

    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.settledAt).not.toBeNull();
    // Refund recovery reads this off the deposit row to list refunds against
    // — without it a lost refund response is unrecoverable.
    expect(after.providerRef).toBe('txn:778899');
    expect(after.providerFee).toBe(7_500);
    expect(after.netAmount).toBe(492_500);
  });

  it('still runs the business side effects, which this task does not move', async () => {
    const { payment } = await submitted('DEPOSIT');

    await send({
      event: 'charge.success',
      data: {
        reference: `DEP_${payment.id}`,
        id: 1,
        metadata: { type: 'deposit' },
      },
    });

    expect(paymentEvents.handleDepositPaymentConfirmed).toHaveBeenCalledWith(
      `DEP_${payment.id}`,
    );
  });

  it('runs the side effects even for a legacy reference that matches no row', async () => {
    // References predating the payment model cannot resolve to a Payment.
    // Those requests must still complete.
    await send({
      event: 'charge.success',
      data: {
        reference: 'DEP_1757000000000_ab12cd3',
        id: 5,
        metadata: { type: 'deposit' },
      },
    });

    expect(paymentEvents.handleDepositPaymentConfirmed).toHaveBeenCalled();
    expect(await prisma.payment.count()).toBe(0);
  });

  it('settles a payout from its own reference, not the transfer code', async () => {
    const { payment } = await submitted('PAYOUT');

    await send({
      event: 'transfer.success',
      data: {
        reference: `payout_${payment.id}`,
        transfer_code: 'TRF_xyz',
        fee_charged: 1_000,
      },
    });

    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.providerRef).toBe('trf:TRF_xyz');
    expect(after.providerFee).toBe(1_000);
  });

  it('maps transfer.reversed to REVERSED rather than a plain failure', async () => {
    const { payment } = await submitted('PAYOUT');

    await send({
      event: 'transfer.reversed',
      data: { reference: `payout_${payment.id}`, transfer_code: 'TRF_xyz' },
    });

    expect((await reload(payment.id)).status).toBe('REVERSED');
  });

  it('finds a refund by providerRef and completes the request-level status', async () => {
    const { request, payment } = await submitted('REFUND');
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: 'refund:4242' },
    });

    await send({ event: 'refund.processed', data: { id: 4242 } });

    expect((await reload(payment.id)).status).toBe('SUCCEEDED');
    // Nothing wrote COMPLETED before this handler existed, so every finished
    // refund used to sit at PENDING forever.
    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.depositRefundStatus).toBe('COMPLETED');
  });

  it('falls back to merchant_note when the create response was lost', async () => {
    // No providerRef: the POST landed but its response never came back, so
    // the note is the only handle that survives.
    const { payment } = await submitted('REFUND');

    await send({
      event: 'refund.processed',
      data: { id: 5151, merchant_note: payment.id },
    });

    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.providerRef).toBe('refund:5151');
  });

  it('ignores a merchant_note pointing at a payment that is not a refund', async () => {
    // merchant_note is free text at Paystack. Matching it against an id must
    // not let a refund webhook settle somebody's deposit.
    const { payment } = await submitted('DEPOSIT');

    await send({
      event: 'refund.processed',
      data: { id: 6262, merchant_note: payment.id },
    });

    expect((await reload(payment.id)).status).toBe('SUBMITTED');
  });

  it('does not overwrite depositRefundStatus when a refund webhook loses its claim', async () => {
    // The Payment row is already FAILED — an earlier refund.failed webhook
    // settled it. A stray or redelivered refund.processed arriving after
    // must not report the request as COMPLETED: claimTerminal's WHERE only
    // matches SUBMITTED/BLOCKED, so the row correctly stays FAILED, and the
    // cascade onto depositRefundStatus must not fire at all for a call that
    // settled nothing — it must not stamp COMPLETED over a request whose
    // refund actually failed.
    const { request, payment } = await submitted('REFUND');
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: 'refund:777' },
    });
    await ledger.claimTerminal(payment.id, { status: 'FAILED' });

    await send({ event: 'refund.processed', data: { id: 777 } });

    expect((await reload(payment.id)).status).toBe('FAILED');
    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    // Untouched — this call settled nothing, so it must not have written
    // COMPLETED over whatever the request's status already was.
    expect(after.depositRefundStatus).toBe('PENDING');
  });

  it('a webhook and a verification racing the same payment produce one transition', async () => {
    const { payment } = await submitted('DEPOSIT');

    // Both call claimTerminal; the guard is the query, so the second finds
    // nothing to claim. This is the normal case, not an edge case.
    const [, verificationWon] = await Promise.all([
      send({
        event: 'charge.success',
        data: {
          reference: `DEP_${payment.id}`,
          id: 1,
          metadata: { type: 'deposit' },
        },
      }),
      ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' }),
    ]);

    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    // Exactly one of the two claimed it.
    const webhookWon = after.providerRef === 'txn:1';
    expect(webhookWon).toBe(!verificationWon);
  });

  it('a redelivered webhook does not re-settle an already terminal payment', async () => {
    const { payment } = await submitted('DEPOSIT');
    const body: PaystackWebhookBody = {
      event: 'charge.success',
      data: {
        reference: `DEP_${payment.id}`,
        id: 1,
        fees: 7_500,
        amount: 500_000,
        metadata: { type: 'deposit' },
      },
    };

    await send(body);
    const first = await reload(payment.id);
    await send(body);
    const second = await reload(payment.id);

    expect(second.settledAt).toEqual(first.settledAt);
  });

  it('never lets a bookkeeping failure block the business side effects', async () => {
    // The payment row is the recoverable part; a notification never sent is
    // not. A malformed body must not cost the customer their confirmation.
    await send({
      event: 'charge.success',
      data: { metadata: { type: 'deposit' } },
    });

    expect(paymentEvents.handleDepositPaymentConfirmed).toHaveBeenCalled();
  });
});
