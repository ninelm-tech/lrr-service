import { Injectable } from '@nestjs/common';
import {
  WhatsAppFlowState,
  WhatsAppSession,
} from './whatsapp-session.types';

@Injectable()
export class WhatsAppSessionStore {
  private readonly sessions = new Map<string, WhatsAppSession>();

  getOrCreate(phoneNumber: string): WhatsAppSession {
    const existing = this.sessions.get(phoneNumber);
    if (existing) return existing;
    const session: WhatsAppSession = {
      phoneNumber,
      state: WhatsAppFlowState.IDLE,
      updatedAt: new Date(),
    };
    this.sessions.set(phoneNumber, session);
    return session;
  }

  update(phoneNumber: string, updates: Partial<WhatsAppSession>) {
    const session = this.getOrCreate(phoneNumber);
    const updatedSession: WhatsAppSession = {
      ...session,
      ...updates,
      updatedAt: new Date(),
    };
    this.sessions.set(phoneNumber, updatedSession);
    return updatedSession;
  }

  clear(phoneNumber: string) {
    this.sessions.delete(phoneNumber);
  }
}
