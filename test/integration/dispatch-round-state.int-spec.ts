import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * Dispatch progression used to live on the customer's WhatsApp session, so
 * one person with two open requests had them share a round and an exclusion
 * list. These assert the RescueRequest is now the only home for it — and
 * that DispatchService is what reads and writes it, which a test that merely
 * wrote the columns itself would not prove.
 */
describe('dispatch round state (integration)', () => {
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

  /**
   * DispatchService with real Postgres and stubs for everything that talks to
   * the outside world. Local to this spec — no other test needs it.
   */
  function buildDispatchService(operatorIds: string[]): DispatchService {
    const twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
    };
    const operatorService = {
      // Returns whatever has not already been excluded, so the exclusion list
      // this spec is about actually drives the result.
      findAndRankCandidates: jest
        .fn()
        .mockImplementation((_lat, _lon, excludeIds: string[] = []) =>
          Promise.resolve(
            operatorIds
              .filter((id) => !excludeIds.includes(id))
              .map((id) => ({
                id,
                businessName: 'Swift Towing',
                phoneNumber: '+2349000000001',
                latitude: 6.4281,
                longitude: 3.4219,
                serviceRadius: 10,
                distance: 1,
                score: 1,
                stats: {},
              })),
          ),
        ),
    };
    const platformConfig = {
      getConfig: jest.fn().mockResolvedValue({
        dispatchWindowMinutes: 10,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 5,
        serviceFeePercent: 10,
        depositPercent: 10,
      }),
    };
    const sessionStore = {
      getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const shared = {
      formatLocationSection: jest.fn().mockResolvedValue('Lekki'),
    };

    return new DispatchService(
      prisma,
      twilio as never,
      operatorService as never,
      platformConfig as never,
      sessionStore as never,
      shared as never,
      {} as never,
    );
  }

  it('records the round and the operators offered on the REQUEST, not the session', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });

    const dispatchService = buildDispatchService([operator.id]);
    await dispatchService.startDispatch(request.id, customer.id);

    const after = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.offeredOperatorIds).toContain(operator.id);

    // And the offer it created carries the round it belongs to.
    const offers = await prisma.dispatchOffer.findMany({
      where: { rescueRequestId: request.id },
    });
    expect(offers).toHaveLength(1);
    expect(offers[0].dispatchRound).toBe(after.dispatchRound);
  });

  it('keeps two requests from the same customer on independent exclusion lists', async () => {
    // The reason this state moved. On the session, dispatching the second
    // request would have seen the first's offered operators as already tried
    // and skipped straight past the only operator in range.
    const customer = await createCustomer(prisma);
    const operatorA = await createOperator(prisma);
    const first = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    const second = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });

    const dispatchService = buildDispatchService([operatorA.id]);
    await dispatchService.startDispatch(first.id, customer.id);
    await dispatchService.startDispatch(second.id, customer.id);

    for (const id of [first.id, second.id]) {
      const offers = await prisma.dispatchOffer.findMany({
        where: { rescueRequestId: id },
      });
      expect(offers).toHaveLength(1);
      expect(offers[0].operatorId).toBe(operatorA.id);
    }
  });

  it('no longer keeps dispatch state on the session at all', async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'WhatsAppSession'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('dispatchRound');
    expect(names).not.toContain('offeredOperatorIds');
  });
});
