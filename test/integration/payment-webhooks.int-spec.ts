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
    confirmDeposit: jest.Mock;
    confirmBalance: jest.Mock;
  };
  let payout: { notifyPayoutOutcome: jest.Mock };

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
      confirmDeposit: jest.fn().mockResolvedValue(undefined),
      confirmBalance: jest.fn().mockResolvedValue(undefined),
    };
    payout = { notifyPayoutOutcome: jest.fn().mockResolvedValue(undefined) };

    service = new PaymentService(
      { get: () => undefined } as never,
      paymentEvents as never,
      payout as never,
      prisma,
      ledger,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
  });

  /** A payment already SUBMITTED, which is the state a webhook arrives into. */
  async function submitted(type: 'DEPOSIT' | 'BALANCE' | 'PAYOUT' | 'REFUND') {
    const customer = await createCustomer(prisma);
    const operator = type === 'PAYOUT' ? await createOperator(prisma) : null;
    const request = await createRequest(prisma, customer.id);
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

  it('runs the business side effects with the settled Payment row, keyed on its own type — not the echoed metadata', async () => {
    const { payment } = await submitted('DEPOSIT');

    await send({
      event: 'charge.success',
      data: {
        reference: `DEP_${payment.id}`,
        id: 1,
        metadata: { type: 'deposit' },
      },
    });

    expect(paymentEvents.confirmDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ id: payment.id, status: 'SUCCEEDED' }),
    );
    expect(paymentEvents.confirmBalance).not.toHaveBeenCalled();
  });

  it('does not run the business side effects for a reference that matches no row', async () => {
    // Every live reference now has a Payment row — Task 11 removed the
    // RescueRequest columns a legacy reference would have matched against.
    // A miss here is a genuine anomaly, not a tolerated transition case:
    // there is no Payment to build the confirmation from.
    await send({
      event: 'charge.success',
      data: {
        reference: 'DEP_nonexistent',
        id: 5,
        metadata: { type: 'deposit' },
      },
    });

    expect(paymentEvents.confirmDeposit).not.toHaveBeenCalled();
    expect(paymentEvents.confirmBalance).not.toHaveBeenCalled();
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
    // Only this call — the one that actually settled it — notifies.
    expect(payout.notifyPayoutOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: payment.id, status: 'SUCCEEDED' }),
    );
  });

  it('maps transfer.reversed to REVERSED rather than a plain failure', async () => {
    const { payment } = await submitted('PAYOUT');

    await send({
      event: 'transfer.reversed',
      data: { reference: `payout_${payment.id}`, transfer_code: 'TRF_xyz' },
    });

    expect((await reload(payment.id)).status).toBe('REVERSED');
  });

  it('finds a refund by providerRef and settles it', async () => {
    const { payment } = await submitted('REFUND');
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: 'refund:4242' },
    });

    await send({ event: 'refund.processed', data: { id: 4242 } });

    // The admin-facing status this used to cascade onto RescueRequest is now
    // purely derived from this row — see derive-payment-state.ts and
    // payment-refund-flow.int-spec.ts. Settling the Payment row is the
    // handler's whole job.
    expect((await reload(payment.id)).status).toBe('SUCCEEDED');
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

  it('a stray refund.processed arriving after the row already FAILED does not resettle it', async () => {
    // An earlier refund.failed webhook already settled this row.
    // claimTerminal's WHERE only matches SUBMITTED/BLOCKED, so this call
    // finds nothing to claim and the row correctly stays FAILED — the same
    // guarantee claimTerminal gives everywhere else, already covered in
    // payment-ledger.int-spec.ts. There is no separate cascade left to get
    // wrong here (see the previous test).
    const { payment } = await submitted('REFUND');
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: 'refund:777' },
    });
    await ledger.claimTerminal(payment.id, { status: 'FAILED' });

    await send({ event: 'refund.processed', data: { id: 777 } });

    expect((await reload(payment.id)).status).toBe('FAILED');
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

  it('a malformed body with no reference settles nothing and calls no business side effect, without throwing', async () => {
    // No reference means no Payment can ever be resolved — post-Task-11
    // there is nothing else to fall back to. Safe handling here means
    // logging/alerting and returning cleanly, not guessing at a request.
    await expect(
      send({
        event: 'charge.success',
        data: { metadata: { type: 'deposit' } },
      }),
    ).resolves.toEqual({ status: 'success' });

    expect(paymentEvents.confirmDeposit).not.toHaveBeenCalled();
    expect(paymentEvents.confirmBalance).not.toHaveBeenCalled();
  });
});
