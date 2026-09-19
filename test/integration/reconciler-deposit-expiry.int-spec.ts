import { DepositExpiryCheck } from '../../src/rescue-request/reconciler/checks/deposit-expiry.check';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOffer,
  createOperator,
  createRequest,
  createSession,
  truncateAll,
} from './factories';

describe('DepositExpiryCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: DepositExpiryCheck;

  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new DepositExpiryCheck(prisma, twilio as never);
  });

  async function awaitingDeposit(expiresAt: Date) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'WAITING_FOR_DEPOSIT',
      depositWindowExpiresAt: expiresAt,
      assignedOperatorId: operator.id,
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'SELECTED_PENDING_PAYMENT',
      dispatchRound: 0,
    });
    return { customer, request, operator, offer };
  }

  it('cancels the request once the window has passed', async () => {
    const { request } = await awaitingDeposit(past());

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(after?.status).toBe('CANCELLED');
  });

  it('releases the operator’s held offer in the same transaction as the cancel', async () => {
    const { offer } = await awaitingDeposit(past());

    await check.run(new Date());

    const after = await prisma.dispatchOffer.findUnique({
      where: { id: offer.id },
    });
    expect(after?.status).toBe('TIMED_OUT');
  });

  it('does nothing before the window passes', async () => {
    const { request } = await awaitingDeposit(future());

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(after?.status).toBe('WAITING_FOR_DEPOSIT');
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not act twice — the cancel moves the row out of its own match', async () => {
    await awaitingDeposit(past());

    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('acts once when two ticks run concurrently', async () => {
    await awaitingDeposit(past());

    await Promise.all([check.run(new Date()), check.run(new Date())]);

    // Two messages for one cancellation: one to the motorist, one to the operator.
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  /*
   * The two cases below guard behaviour the timer this check replaces
   * performed and which is easy to lose in the move: without them the
   * motorist is left mid-flow on a cancelled job, and any open chat relay
   * stays open forever. Both are stale-state bugs of exactly the kind this
   * work exists to remove.
   */

  it('resets the motorist’s session, so their next message does not hit a cancelled job', async () => {
    const { customer, request } = await awaitingDeposit(past());
    await createSession(prisma, customer.id, {
      state: 'OPERATOR_FOUND_WAITING_PAYMENT',
      rescueRequestId: request.id,
    });

    await check.run(new Date());

    const session = await prisma.whatsAppSession.findUnique({
      where: { userId: customer.id },
    });
    expect(session?.state).toBe('IDLE');
    expect(session?.rescueRequestId).toBeNull();
  });

  it('closes an open chat relay on both sides', async () => {
    const { customer, request, operator } = await awaitingDeposit(past());
    const operatorUser = await createCustomer(prisma, operator.phoneNumber!);
    await createSession(prisma, customer.id, {
      state: 'OPERATOR_FOUND_WAITING_PAYMENT',
      rescueRequestId: request.id,
      relayTarget: 'OPERATOR',
    });
    await createSession(prisma, operatorUser.id, {
      state: 'IDLE',
      rescueRequestId: request.id,
      relayTarget: 'CUSTOMER',
    });

    await check.run(new Date());

    const sessions = await prisma.whatsAppSession.findMany({
      where: { rescueRequestId: request.id },
    });
    // Both sides cleared. A relay left half-open locks the other party out of
    // every later job — the lockout fixed on 2026-09-12.
    expect(sessions.every((s) => s.relayTarget === null)).toBe(true);
  });

  it('rolls the cancel back if releasing the offer fails, leaving the request still matchable', async () => {
    const { request, offer } = await awaitingDeposit(past());

    // Fail the offer release INSIDE the transaction, as a crash would.
    // Spying on prisma.dispatchOffer.updateMany would NOT work: inside
    // $transaction the check uses the transaction client, a different object
    // the spy never touches. Intercept the transaction and proxy its client.
    const realTransaction = prisma.$transaction.bind(prisma);
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(
        (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          realTransaction(async (tx) =>
            fn({
              ...tx,
              dispatchOffer: {
                ...tx.dispatchOffer,
                updateMany: () => Promise.reject(new Error('connection lost')),
              },
            } as Prisma.TransactionClient),
          ),
      );

    await expect(check.run(new Date())).rejects.toThrow('connection lost');

    // The claim must NOT have survived: a cancelled request whose offer is
    // still held matches no check ever again.
    const during = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(during?.status).toBe('WAITING_FOR_DEPOSIT');
    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))
        ?.status,
    ).toBe('SELECTED_PENDING_PAYMENT');

    // And the next tick completes it cleanly.
    spy.mockRestore();
    await check.run(new Date());

    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.status,
    ).toBe('CANCELLED');
    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
  });

  it('never leaves a request awaiting deposit without a deadline', async () => {
    // Whatever path produced it, such a row is invisible to every check —
    // it would hold its operator and block the motorist forever.
    const orphans = await prisma.rescueRequest.count({
      where: {
        status: 'WAITING_FOR_DEPOSIT',
        depositWindowExpiresAt: null,
      },
    });
    expect(orphans).toBe(0);
  });
});
