import { Test, TestingModule } from '@nestjs/testing';
import { DispatchOfferSweeperService } from './dispatch-offer-sweeper.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DispatchOfferSweeperService', () => {
  let service: DispatchOfferSweeperService;
  let prisma: { dispatchOffer: { updateMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { dispatchOffer: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };

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

  it('never throws when the database call fails — the interval must keep running', async () => {
    prisma.dispatchOffer.updateMany.mockRejectedValue(new Error('connection lost'));
    await expect(service.sweep()).resolves.toBe(0);
  });

  it('sweeps once immediately on boot, so a restart clears the orphans it just created', () => {
    service.onModuleInit();
    expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledTimes(1);
  });
});
