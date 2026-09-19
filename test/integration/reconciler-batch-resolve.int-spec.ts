import { BatchResolveCheck } from '../../src/rescue-request/reconciler/checks/batch-resolve.check';
import { BiddingCloseCheck } from '../../src/rescue-request/reconciler/checks/bidding-close.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOffer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

describe('BatchResolveCheck (integration)', () => {
  let prisma: PrismaService;
  let dispatch: {
    prepareNextRound: jest.Mock;
    deliverOffers: jest.Mock;
    deliverQuoteShortlist: jest.Mock;
    notifyNoOperatorAvailable: jest.Mock;
  };
  let check: BatchResolveCheck;

  const expired = () => new Date(Date.now() - 60_000);

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The mock must match the methods the check actually calls. Mocking
    // startDispatch here would make several assertions vacuous AND throw on
    // the happy path, since prepareNextRound would be undefined.
    dispatch = {
      // Never `{ offers: [], exhausted: false }` — prepareNextRound's
      // contract forbids it, and a mock modelling an impossible state tests
      // nothing.
      prepareNextRound: jest.fn().mockResolvedValue({
        offers: [{ operatorPhone: '+2349000000001', jobRef: 'AAA111' }],
        exhausted: false,
        round: 1,
      }),
      deliverOffers: jest.fn().mockResolvedValue(undefined),
      deliverQuoteShortlist: jest.fn().mockResolvedValue(undefined),
      notifyNoOperatorAvailable: jest.fn().mockResolvedValue(undefined),
    };
    check = new BatchResolveCheck(prisma, dispatch as never);
  });

  async function scenario(opts: {
    requestRound: number;
    batchRound: number;
    deadline: Date | null;
  }) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      dispatchRound: opts.requestRound,
      quoteCollectionDeadline: opts.deadline,
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'PENDING',
      expiresAt: expired(),
      dispatchRound: opts.batchRound,
    });
    return { request, offer };
  }

  it('expires its own offers and starts the next round in phase 1', async () => {
    const { request, offer } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });

    await check.run(new Date());

    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).toHaveBeenCalled();
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.dispatchRound,
    ).toBe(1);
  });

  it('does not progress in phase 2 — bidding close owns it', async () => {
    const { request, offer } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: new Date(Date.now() + 60_000),
    });

    await check.run(new Date());

    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.dispatchRound,
    ).toBe(0);
  });

  it('a stale round-1 batch cannot advance a request already on round 2', async () => {
    const { request, offer } = await scenario({
      requestRound: 2,
      batchRound: 1,
      deadline: null,
    });

    await check.run(new Date());

    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.dispatchRound,
    ).toBe(2);
  });

  it('advances exactly one round when two ticks run concurrently', async () => {
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });

    await Promise.all([check.run(new Date()), check.run(new Date())]);

    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.dispatchRound,
    ).toBe(1);
    expect(dispatch.prepareNextRound).toHaveBeenCalledTimes(1);
  });

  it('does not start a round when a first quote lands between the query and the claim', async () => {
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });

    // Set the deadline after the check has read its offers but before it
    // claims — exactly what an operator's first quote does concurrently.
    // Hook dispatchOffer.findMany: that is the query BatchResolveCheck
    // actually issues. (rescueRequest.findMany is never called here, so a
    // spy on it would make this test silently vacuous.)
    const findMany = prisma.dispatchOffer.findMany.bind(prisma.dispatchOffer);
    const spy = jest
      .spyOn(prisma.dispatchOffer, 'findMany')
      .mockImplementation(((args: Parameters<typeof findMany>[0]) =>
        (async () => {
          const rows = await findMany(args);
          await prisma.rescueRequest.update({
            where: { id: request.id },
            data: { quoteCollectionDeadline: new Date(Date.now() + 60_000) },
          });
          return rows;
        })()) as never);

    await check.run(new Date());
    spy.mockRestore();

    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.dispatchRound,
    ).toBe(0);
  });

  it('yields to bidding close — the request is progressed exactly once, even concurrently', async () => {
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: new Date(Date.now() - 60_000),
    });
    const biddingClose = new BiddingCloseCheck(prisma, dispatch as never);

    // Run them together. Sequentially, the first simply wins and the test
    // proves only ordering; the interesting claim is that the two claims
    // cannot both succeed when they interleave.
    await Promise.all([biddingClose.run(new Date()), check.run(new Date())]);

    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledTimes(1);
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();

    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.biddingClosedAt).not.toBeNull();
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(after.dispatchRound).toBe(0);
  });

  it('cancels in the same transaction when no operator remains, rather than advancing into silence', async () => {
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });
    dispatch.prepareNextRound.mockResolvedValue({
      offers: [],
      exhausted: true,
      reason: 'rounds-exhausted',
      round: 4,
    });

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe('CANCELLED');
    expect(dispatch.notifyNoOperatorAvailable).toHaveBeenCalledWith(
      request.id,
      expect.any(String),
      'rounds-exhausted',
      4,
    );
    expect(dispatch.deliverOffers).not.toHaveBeenCalled();
  });

  it('opens the selection window in the same transaction when quotes exist', async () => {
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });
    const operator = await createOperator(prisma);
    await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 2_000_000,
    });

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(after.biddingClosedAt).not.toBeNull(); // claims the backstop too
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalled();
  });

  it('closes every remaining PENDING offer when it shortlists, not just its own batch', async () => {
    // Another batch, or an admin's manual offer, can still be live. An
    // operator answering one after the motorist already has a shortlist
    // would be quoting into a closed auction.
    const { request } = await scenario({
      requestRound: 0,
      batchRound: 0,
      deadline: null,
    });
    const quoter = await createOperator(prisma);
    await createOffer(prisma, request.id, quoter.id, {
      status: 'QUOTED',
      quotedPrice: 2_000_000,
    });
    const other = await createOperator(prisma);
    const stillLive = await createOffer(prisma, request.id, other.id, {
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 10 * 60_000), // not expired — a different batch
      batchId: 'other-batch',
    });

    await check.run(new Date());

    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: stillLive.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
  });
});
