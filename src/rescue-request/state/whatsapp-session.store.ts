import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WhatsAppFlowState,
  WhatsAppSession,
} from './whatsapp-session.types';

/**
 * DB-backed WhatsApp session store, keyed by userId.
 *
 * Every inbound Twilio message carries a phone number. The caller is responsible
 * for resolving that to a User (creating one if needed) BEFORE calling this store.
 * That way the session table has no redundant phone number column.
 */
@Injectable()
export class WhatsAppSessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string): Promise<WhatsAppSession> {
    const row = await this.prisma.whatsAppSession.upsert({
      where:  { userId },
      create: {
        userId,
        state: WhatsAppFlowState.IDLE,
        offeredOperatorIds: '[]',
      },
      update: {}, // just fetch if already exists
    });

    return this.rowToSession(row);
  }

  async update(
    userId: string,
    updates: Partial<WhatsAppSession>,
  ): Promise<WhatsAppSession> {
    const data: Record<string, any> = {};

    if (updates.state !== undefined)            data.state = updates.state;
    if (updates.latitude !== undefined)         data.latitude = updates.latitude;
    if (updates.longitude !== undefined)        data.longitude = updates.longitude;
    if (updates.issueType !== undefined)        data.issueType = updates.issueType;
    if (updates.vehicleType !== undefined)      data.vehicleType = updates.vehicleType;
    if (updates.destination !== undefined)      data.destination = updates.destination;
    if (updates.rescueRequestId !== undefined)  data.rescueRequestId = updates.rescueRequestId;
    if (updates.depositReference !== undefined) data.depositReference = updates.depositReference;
    if (updates.dispatchRound !== undefined)    data.dispatchRound = updates.dispatchRound;
    if (updates.offeredOperatorIds !== undefined) {
      data.offeredOperatorIds = JSON.stringify(updates.offeredOperatorIds);
    }
    if (updates.relayTarget !== undefined)      data.relayTarget = updates.relayTarget;

    const row = await this.prisma.whatsAppSession.update({
      where:  { userId },
      data,
    });

    return this.rowToSession(row);
  }

  async clear(userId: string): Promise<void> {
    await this.prisma.whatsAppSession.deleteMany({ where: { userId } });
  }

  /**
   * Drops any open chat relay for these users, returning how many were
   * actually cleared so the caller can stay silent when no relay was open.
   *
   * updateMany, not update: a participant may have no session row at all,
   * which update() treats as an error.
   */
  async clearRelayTargets(userIds: string[]): Promise<number> {
    const { count } = await this.prisma.whatsAppSession.updateMany({
      where: { userId: { in: userIds }, relayTarget: { not: null } },
      data: { relayTarget: null },
    });
    return count;
  }

  private rowToSession(row: any): WhatsAppSession {
    return {
      userId: row.userId,
      state: row.state as WhatsAppFlowState,
      latitude: row.latitude != null ? Number(row.latitude) : undefined,
      longitude: row.longitude != null ? Number(row.longitude) : undefined,
      issueType: row.issueType ?? undefined,
      vehicleType: row.vehicleType ?? undefined,
      destination: row.destination ?? undefined,
      rescueRequestId: row.rescueRequestId ?? undefined,
      depositReference: row.depositReference ?? undefined,
      dispatchRound: row.dispatchRound ?? 0,
      offeredOperatorIds: row.offeredOperatorIds
        ? JSON.parse(row.offeredOperatorIds)
        : [],
      relayTarget: row.relayTarget ?? undefined,
      updatedAt: row.updatedAt,
    };
  }
}
