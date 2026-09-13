import { QuoteSelectionTimeoutCheck } from '../../src/rescue-request/reconciler/checks/quote-selection-timeout.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOffer,
  createOperator,
  createRequest,
  createSession,
  truncateAll,
} from './factories';

describe('QuoteSelectionTimeoutCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: QuoteSelectionTimeoutCheck;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new QuoteSelectionTimeoutCheck(prisma, twilio as never);
  });

  async function awaitingSelection(offsetMs: number) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      quoteSelectionExpiresAt: new Date(Date.now() + offsetMs),
    });
    await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 2_000_000,
      dispatchRound: 0,
    });
    return { customer, request };
  }

  it('cancels when the motorist never chooses', async () => {
    const { request } = await awaitingSelection(-60_000);

    await check.run(new Date());

    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.status,
    ).toBe('CANCELLED');
  });

  it('releases the quoting operators', async () => {
    const { request } = await awaitingSelection(-60_000);

    await check.run(new Date());

    const offers = await prisma.dispatchOffer.findMany({
      where: { rescueRequestId: request.id },
    });
    expect(offers.every((o) => o.status === 'TIMED_OUT')).toBe(true);
  });

  it('resets the motorist’s session, so their next message does not hit a cancelled job', async () => {
    // The timer this replaces cleared the session too. Left at
    // WAITING_FOR_QUOTE_SELECTION, the motorist's next reply is read as a
    // quote choice for a request that no longer exists.
    const { customer, request } = await awaitingSelection(-60_000);
    await createSession(prisma, customer.id, {
      state: 'WAITING_FOR_QUOTE_SELECTION',
      rescueRequestId: request.id,
    });

    await check.run(new Date());

    const session = await prisma.whatsAppSession.findUnique({
      where: { userId: customer.id },
    });
    expect(session?.state).toBe('IDLE');
    expect(session?.rescueRequestId).toBeNull();
  });

  it('does nothing before the deadline', async () => {
    const { request } = await awaitingSelection(60_000);
    await check.run(new Date());
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.status,
    ).toBe('DISPATCHING');
  });

  it('does not act twice', async () => {
    await awaitingSelection(-60_000);
    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('acts once when two ticks run concurrently', async () => {
    await awaitingSelection(-60_000);

    await Promise.all([check.run(new Date()), check.run(new Date())]);

    // One motorist message plus one operator message, for one cancellation.
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });
});
