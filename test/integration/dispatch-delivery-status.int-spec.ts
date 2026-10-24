import * as crypto from 'crypto';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * handleDeliveryStatusUpdate's out-of-order guard is built as a Prisma
 * `updateMany` WHERE clause (see dispatch.service.spec.ts's "out-of-order
 * guard construction" tests), which only proves DispatchService constructs
 * the right clause shape — not that Postgres actually filters on `in`,
 * `notIn`, and `null` the way that shape intends. Multi-llm review caught
 * that the unit spec's own comment claimed this was "covered by the
 * real-Postgres integration test added alongside this task," but no such
 * test existed — this file is that test.
 */
describe('dispatch delivery-status guard (integration)', () => {
  let prisma: PrismaService;
  let dispatchService: DispatchService;

  beforeAll(() => {
    prisma = new PrismaService();
    dispatchService = new DispatchService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function createOffer(deliveryStatus: string | null) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    return prisma.dispatchOffer.create({
      data: {
        rescueRequestId: request.id,
        operatorId: operator.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        batchId: crypto.randomUUID(),
        dispatchRound: 1,
        deliveryStatus,
      },
    });
  }

  it('writes a more-advanced status over a less-advanced one', async () => {
    const offer = await createOffer('sent');

    await dispatchService.handleDeliveryStatusUpdate(
      offer.id,
      'SM123',
      'delivered',
      undefined,
    );

    const after = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(after.deliveryStatus).toBe('delivered');
  });

  it('rejects a less-advanced status arriving after a more-advanced one — the out-of-order case this guard exists for', async () => {
    const offer = await createOffer('delivered');

    await dispatchService.handleDeliveryStatusUpdate(
      offer.id,
      'SM123',
      'sent',
      undefined,
    );

    const after = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    // Still 'delivered' — the late 'sent' callback was rejected, not
    // applied, by Postgres's own evaluation of the WHERE clause.
    expect(after.deliveryStatus).toBe('delivered');
  });

  it('rejects one terminal status overwriting a different terminal status — a redelivered/late failure must not erase a confirmed read', async () => {
    const offer = await createOffer('read');

    await dispatchService.handleDeliveryStatusUpdate(
      offer.id,
      'SM123',
      'failed',
      30008,
    );

    const after = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(after.deliveryStatus).toBe('read');
    expect(after.deliveryErrorCode).toBeNull();
  });

  it('writes over a null deliveryStatus — the first callback for an offer', async () => {
    const offer = await createOffer(null);

    await dispatchService.handleDeliveryStatusUpdate(
      offer.id,
      'SM123',
      'sent',
      undefined,
    );

    const after = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(after.deliveryStatus).toBe('sent');
  });
});
