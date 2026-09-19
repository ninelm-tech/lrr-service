import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppSessionStore } from './whatsapp-session.store';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppFlowState } from './whatsapp-session.types';

describe('WhatsAppSessionStore', () => {
  let store: WhatsAppSessionStore;
  let prisma: { whatsAppSession: { update: jest.Mock; upsert: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      whatsAppSession: {
        update: jest.fn(),
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppSessionStore,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    store = module.get<WhatsAppSessionStore>(WhatsAppSessionStore);
  });

  it('persists vehicleType and destination when updating a session', async () => {
    prisma.whatsAppSession.update.mockResolvedValue({
      userId: 'user-1',
      state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      latitude: null,
      longitude: null,
      issueType: null,
      vehicleType: 'SEDAN',
      destination: '123 Workshop Road',
      rescueRequestId: null,
      depositReference: null,
      updatedAt: new Date(),
    });

    const result = await store.update('user-1', {
      vehicleType: 'SEDAN',
      destination: '123 Workshop Road',
    });

    expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { vehicleType: 'SEDAN', destination: '123 Workshop Road' },
    });
    expect(result.vehicleType).toBe('SEDAN');
    expect(result.destination).toBe('123 Workshop Road');
  });

  it('persists relayTarget when updating a session', async () => {
    prisma.whatsAppSession.update.mockResolvedValue({
      userId: 'user-1',
      state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      latitude: null,
      longitude: null,
      issueType: null,
      vehicleType: null,
      destination: null,
      rescueRequestId: 'req-1',
      depositReference: null,
      relayTarget: 'OPERATOR',
      updatedAt: new Date(),
    });

    const result = await store.update('user-1', { relayTarget: 'OPERATOR' });

    expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { relayTarget: 'OPERATOR' },
    });
    expect(result.relayTarget).toBe('OPERATOR');
  });

  it('treats a rating prompt older than ten minutes as IDLE, without writing anything', async () => {
    prisma.whatsAppSession.upsert.mockResolvedValue({
      userId: 'u1',
      state: 'WAITING_FOR_RATING',
      rescueRequestId: 'req-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    const session = await store.getOrCreate('u1');

    expect(session.state).toBe('IDLE');
    // The timer this replaces cleared the request id too. Reporting IDLE
    // while still carrying the finished job would let later code act on it.
    expect(session.rescueRequestId).toBeUndefined();
    expect(prisma.whatsAppSession.update).not.toHaveBeenCalled();
  });

  it('keeps a recent rating prompt active', async () => {
    prisma.whatsAppSession.upsert.mockResolvedValue({
      userId: 'u1',
      state: 'WAITING_FOR_RATING',
      rescueRequestId: 'req-1',
      updatedAt: new Date(Date.now() - 60 * 1000),
    });

    const session = await store.getOrCreate('u1');

    expect(session.state).toBe('WAITING_FOR_RATING');
    expect(session.rescueRequestId).toBe('req-1');
  });

  it('does not stale-out a state that is not a rating prompt', async () => {
    prisma.whatsAppSession.upsert.mockResolvedValue({
      userId: 'u1',
      state: 'AWAITING_COMPLETION_CONFIRM',
      rescueRequestId: 'req-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    const session = await store.getOrCreate('u1');

    expect(session.state).toBe('AWAITING_COMPLETION_CONFIRM');
  });
});
