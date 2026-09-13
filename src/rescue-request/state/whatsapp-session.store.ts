import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppSession as WhatsAppSessionRow } from '@prisma/client';
import {
  IssueType,
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
/**
 * A rating prompt goes stale rather than being cleared by a timer. Nothing
 * outbound happens at the deadline — the prompt simply stops applying — so
 * this is derived on read instead of scheduled. One place, so no reader can
 * forget it.
 *
 * `updatedAt` is the prompt time because setting WAITING_FOR_RATING is the
 * last write to the row; a later unrelated write would extend the window,
 * which is acceptable for quiet cleanup that blocks nothing.
 */
const RATING_PROMPT_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class WhatsAppSessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string): Promise<WhatsAppSession> {
    const row = await this.prisma.whatsAppSession.upsert({
      where: { userId },
      create: {
        userId,
        state: WhatsAppFlowState.IDLE,
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

    if (updates.state !== undefined) data.state = updates.state;
    if (updates.latitude !== undefined) data.latitude = updates.latitude;
    if (updates.longitude !== undefined) data.longitude = updates.longitude;
    if (updates.issueType !== undefined) data.issueType = updates.issueType;
    if (updates.vehicleType !== undefined)
      data.vehicleType = updates.vehicleType;
    if (updates.destination !== undefined)
      data.destination = updates.destination;
    if (updates.rescueRequestId !== undefined)
      data.rescueRequestId = updates.rescueRequestId;
    if (updates.depositReference !== undefined)
      data.depositReference = updates.depositReference;
    if (updates.relayTarget !== undefined)
      data.relayTarget = updates.relayTarget;

    const row = await this.prisma.whatsAppSession.update({
      where: { userId },
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

  private rowToSession(row: WhatsAppSessionRow): WhatsAppSession {
    const rawState = row.state as WhatsAppFlowState;
    const ratingExpired =
      rawState === WhatsAppFlowState.WAITING_FOR_RATING &&
      Date.now() - new Date(row.updatedAt).getTime() > RATING_PROMPT_TTL_MS;

    return {
      userId: row.userId,
      state: ratingExpired ? WhatsAppFlowState.IDLE : rawState,
      latitude: row.latitude != null ? Number(row.latitude) : undefined,
      longitude: row.longitude != null ? Number(row.longitude) : undefined,
      // These two are String columns holding a narrower domain type. Nothing
      // but this app writes them, so the cast is safe — but it is a cast, and
      // the previous `any` on this parameter was hiding that.
      issueType: (row.issueType as IssueType | null) ?? undefined,
      vehicleType: row.vehicleType ?? undefined,
      destination: row.destination ?? undefined,
      // The timer this replaces cleared BOTH state and rescueRequestId.
      // Returning IDLE while still carrying the finished job's id would
      // leave later code acting on a request the session no longer has any
      // business touching — a subtler version of the stale-state bugs this
      // work exists to remove.
      rescueRequestId: ratingExpired
        ? undefined
        : (row.rescueRequestId ?? undefined),
      depositReference: row.depositReference ?? undefined,
      relayTarget:
        (row.relayTarget as 'OPERATOR' | 'CUSTOMER' | null) ?? undefined,
      updatedAt: row.updatedAt,
    };
  }
}
