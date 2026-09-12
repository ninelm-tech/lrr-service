import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchOfferSweeperService } from '../../src/rescue-request/dispatch-offer-sweeper.service';
import {
  createCustomer,
  createOffer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * The sweeper is pure database behaviour — which rows its filters match is
 * the entire feature. A unit test with a mocked Prisma can only assert the
 * shape of the query object it was handed, never that the query selects the
 * right rows, so these run against real Postgres.
 *
 * The first case here is the bug found during the 2026-09-12 test pass: an
 * operator was shown three "open" jobs that had already ended.
 */
describe('DispatchOfferSweeperService (integration)', () => {
  let prisma: PrismaService;
  let sweeper: DispatchOfferSweeperService;

  beforeAll(() => {
    prisma = new PrismaService();
    sweeper = new DispatchOfferSweeperService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('closes an offer on a request that already ended, even though its window is still open', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'COMPLETED' });
    // Still in its 10-minute window — this is precisely why the expiry sweep
    // misses it and the operator kept seeing a finished job as open.
    const offer = await createOffer(prisma, request.id, operator.id);

    await sweeper.sweep();

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('TIMED_OUT');
  });

  it('closes an offer on a cancelled request too', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'CANCELLED' });
    const offer = await createOffer(prisma, request.id, operator.id);

    await sweeper.sweep();

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('TIMED_OUT');
  });

  it('leaves a live offer on a live request alone — the sweep must never close a real bid', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });
    const offer = await createOffer(prisma, request.id, operator.id);

    await sweeper.sweep();

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('PENDING');
  });

  it('still closes an expired offer on a live request', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });
    const offer = await createOffer(prisma, request.id, operator.id, {
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    await sweeper.sweep();

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('TIMED_OUT');
  });

  it('does not disturb an offer the operator already answered', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'COMPLETED' });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 2_500_000,
    });

    await sweeper.sweep();

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('QUOTED');
  });
});
