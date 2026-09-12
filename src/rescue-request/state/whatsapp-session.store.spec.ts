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
      dispatchRound: 0,
      offeredOperatorIds: '[]',
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
      dispatchRound: 0,
      offeredOperatorIds: '[]',
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
});
