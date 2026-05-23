import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  WhatsAppFlowState,
  WhatsAppSession,
} from './whatsapp-session.types';

/**
 * DB-backed WhatsApp session store.
 * Uses the WhatsAppSession table so sessions survive server restarts.
 * All methods are async to allow DB I/O.
 */
@Injectable()
export class WhatsAppSessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(phoneNumber: string): Promise<WhatsAppSession> {
    const row = await this.prisma.whatsAppSession.findUnique({
      where: { phoneNumber },
    });

    if (row) {
      return this.rowToSession(row);
    }

    const created = await this.prisma.whatsAppSession.create({
      data: {
        phoneNumber,
        state: WhatsAppFlowState.IDLE,
      },
    });

    return this.rowToSession(created);
  }

  async update(phoneNumber: string, updates: Partial<WhatsAppSession>): Promise<WhatsAppSession> {
    const data: Record<string, any> = {};

    if (updates.state !== undefined) data.state = updates.state;
    if (updates.latitude !== undefined) data.latitude = updates.latitude;
    if (updates.longitude !== undefined) data.longitude = updates.longitude;
    if (updates.issueType !== undefined) data.issueType = updates.issueType;
    if (updates.rescueRequestId !== undefined) data.rescueRequestId = updates.rescueRequestId;
    if (updates.depositReference !== undefined) data.depositReference = updates.depositReference;
    if (updates.dispatchRound !== undefined) data.dispatchRound = updates.dispatchRound;
    if (updates.offeredOperatorIds !== undefined) {
      data.offeredOperatorIds = JSON.stringify(updates.offeredOperatorIds);
    }

    const row = await this.prisma.whatsAppSession.upsert({
      where: { phoneNumber },
      create: {
        phoneNumber,
        state: updates.state ?? WhatsAppFlowState.IDLE,
        ...data,
      },
      update: data,
    });

    return this.rowToSession(row);
  }

  async clear(phoneNumber: string): Promise<void> {
    await this.prisma.whatsAppSession.deleteMany({
      where: { phoneNumber },
    });
  }

  private rowToSession(row: any): WhatsAppSession {
    return {
      phoneNumber: row.phoneNumber,
      state: row.state as WhatsAppFlowState,
      latitude: row.latitude ? Number(row.latitude) : undefined,
      longitude: row.longitude ? Number(row.longitude) : undefined,
      issueType: row.issueType ?? undefined,
      rescueRequestId: row.rescueRequestId ?? undefined,
      depositReference: row.depositReference ?? undefined,
      dispatchRound: row.dispatchRound ?? 0,
      offeredOperatorIds: row.offeredOperatorIds
        ? JSON.parse(row.offeredOperatorIds)
        : [],
      updatedAt: row.updatedAt,
    };
  }
}