import { BiddingCloseCheck } from '../../src/rescue-request/reconciler/checks/bidding-close.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOffer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

describe('BiddingCloseCheck (integration)', () => {
  let prisma: PrismaService;
  let dispatch: { deliverQuoteShortlist: jest.Mock };
  let check: BiddingCloseCheck;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    dispatch = {
      deliverQuoteShortlist: jest.fn().mockResolvedValue(undefined),
    };
    check = new BiddingCloseCheck(prisma, dispatch as never);
  });

  async function dispatching(
    deadlineOffsetMs: number,
    biddingClosedAt: Date | null = null,
  ) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      quoteCollectionDeadline: new Date(Date.now() + deadlineOffsetMs),
      biddingClosedAt,
    });
    await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 2_500_000,
      dispatchRound: 0,
    });
    return request;
  }

  it('closes bidding and hands the request to the selection window', async () => {
    const request = await dispatching(-60_000);

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.biddingClosedAt).not.toBeNull();
    // Both stamps must land in the SAME transaction: with biddingClosedAt set
    // and no selection deadline, neither check could ever match this row again.
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledWith(
      request.id,
      expect.any(String),
    );
  });

  it('closes the remaining offers in the same transaction as the claim', async () => {
    const request = await dispatching(-60_000);
    const operator = await createOperator(prisma);
    const pending = await createOffer(prisma, request.id, operator.id, {
      status: 'PENDING',
    });

    await check.run(new Date());

    expect(
      (await prisma.dispatchOffer.findUnique({ where: { id: pending.id } }))
        ?.status,
    ).toBe('TIMED_OUT');
  });

  it('does nothing before the deadline', async () => {
    await dispatching(60_000);
    await check.run(new Date());
    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
  });

  it('does not close a second time', async () => {
    await dispatching(-60_000);

    await check.run(new Date());
    dispatch.deliverQuoteShortlist.mockClear();
    await check.run(new Date());

    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
  });

  it('closes once when two ticks run concurrently', async () => {
    await dispatching(-60_000);
    await Promise.all([check.run(new Date()), check.run(new Date())]);
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledTimes(1);
  });
});
