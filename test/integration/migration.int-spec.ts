import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * Guards the two properties of the durable_scheduling migration that the
 * schema file alone cannot express: that pre-migration offers were given a
 * sentinel round no live request can occupy, and that the column kept no
 * default afterwards.
 *
 * Both are only observable against real Postgres — the generated Prisma
 * client would happily describe a column whose actual DDL is wrong.
 */
describe('durable_scheduling migration (integration)', () => {
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

  it('leaves legacy offers on a round no request can ever occupy', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id);

    // Simulate a row written before the migration: insert bypassing the
    // Prisma client's now-required dispatchRound, then read it back.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "DispatchOffer"
        ("id","rescueRequestId","operatorId","status","expiresAt","batchId","dispatchRound","offeredAt")
      VALUES ('legacy-1', $1, $2, 'PENDING', now() + interval '10 minutes', 'legacy-batch', -1, now())
    `,
      request.id,
      operator.id,
    );

    const legacy = await prisma.dispatchOffer.findUnique({
      where: { id: 'legacy-1' },
    });
    expect(legacy?.dispatchRound).toBe(-1);

    // A fresh request starts at round 0, so -1 can never match it.
    expect(request.dispatchRound).toBe(0);
    expect(legacy!.dispatchRound).not.toBe(request.dispatchRound);
  });

  it('requires an explicit dispatchRound on new offers — the column has no default', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id);

    await expect(
      prisma.$executeRawUnsafe(
        `
        INSERT INTO "DispatchOffer"
          ("id","rescueRequestId","operatorId","status","expiresAt","batchId","offeredAt")
        VALUES ('no-round', $1, $2, 'PENDING', now() + interval '10 minutes', 'b', now())
      `,
        request.id,
        operator.id,
      ),
    ).rejects.toThrow();
  });
});
