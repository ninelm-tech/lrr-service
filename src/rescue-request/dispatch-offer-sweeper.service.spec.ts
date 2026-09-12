import { Test, TestingModule } from '@nestjs/testing';
import { DispatchOfferSweeperService } from './dispatch-offer-sweeper.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DispatchOfferSweeperService', () => {
  let service: DispatchOfferSweeperService;
  let prisma: { dispatchOffer: { updateMany: jest.Mock; findMany: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      dispatchOffer: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DispatchOfferSweeperService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DispatchOfferSweeperService);
  });

  afterEach(() => service.onModuleDestroy());

  it('times out only PENDING offers whose expiresAt has already passed', async () => {
    await service.sweep();

    const arg = prisma.dispatchOffer.updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe('PENDING');
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('TIMED_OUT');
  });

  it('returns the number of offers swept', async () => {
    prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 3 });
    await expect(service.sweep()).resolves.toBe(3);
  });

  it('also closes PENDING offers on requests that already ended, which the expiry sweep cannot see', async () => {
    prisma.dispatchOffer.findMany.mockResolvedValue([
      { id: 'offer-1' },
      { id: 'offer-2' },
    ]);
    prisma.dispatchOffer.updateMany
      .mockResolvedValueOnce({ count: 0 }) // expiry sweep
      .mockResolvedValueOnce({ count: 2 }); // orphans on ended requests

    await expect(service.sweep()).resolves.toBe(2);

    // Matched on the request's terminal status, NOT on expiresAt — these
    // offers are still inside their window, which is why they were missed.
    const findArg = prisma.dispatchOffer.findMany.mock.calls[0][0];
    expect(findArg.where.status).toBe('PENDING');
    expect(findArg.where.rescueRequest.status.in).toEqual([
      'COMPLETED',
      'CANCELLED',
    ]);
    expect(findArg.where.expiresAt).toBeUndefined();

    expect(prisma.dispatchOffer.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['offer-1', 'offer-2'] } },
      data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
    });
  });

  it('skips the orphan update entirely when there are none, rather than issuing an empty IN ()', async () => {
    await service.sweep();

    expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1);
  });

  it('never throws when the database call fails — the interval must keep running', async () => {
    prisma.dispatchOffer.updateMany.mockRejectedValue(
      new Error('connection lost'),
    );
    await expect(service.sweep()).resolves.toBe(0);
  });

  it('sweeps once immediately on boot, so a restart clears the orphans it just created', () => {
    service.onModuleInit();
    expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1);
  });
});
