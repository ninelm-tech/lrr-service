import { Injectable } from '@nestjs/common';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';

/**
 * Thin channel-level router: resolves (or creates) the sending User, then
 * routes to the operator or customer WhatsApp flow. This is the only
 * decision this service makes — everything else (dispute handling, ratings,
 * the state machine) lives inside whichever flow owns it.
 */
@Injectable()
export class WhatsAppInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly operatorFlow: WhatsAppOperatorFlowService,
    private readonly customerFlow: WhatsAppCustomerFlowService,
    private readonly sharedService: RescueRequestSharedService,
  ) {}

  async handleIncomingWhatsAppMessage(body: Record<string, any>): Promise<string> {
    // Twilio always delivers E.164 with country code — just strip the whatsapp: prefix
    const phoneNumber: string = String(body.From || '').replace(/^whatsapp:/i, '');
    const rawMessage = String(body.Body || '').trim();
    const message = rawMessage.toLowerCase();
    const latitude  = body.Latitude  ? Number(body.Latitude)  : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;
    // Present when a "search for a place" share includes WhatsApp's own
    // formatted address/place name — absent for a bare "current location" pin.
    const sharedAddress = body.Address ? String(body.Address).trim() : undefined;

    // Structured, not console.log — plain console.log on this path was never
    // shipped to Sentry (confirmed 2026-08-25 while investigating an
    // "operator stuck after ARRIVED" report with zero trace of the inbound
    // message anywhere), so this route had no diagnosability at all.
    logger.info('whatsapp: inbound message', { phoneNumber, message, latitude, longitude });

    // Always resolve (or create) a User for this phone number.
    // Operators and customers both have a User record — this is our session key.
    const user = await this.sharedService.findOrCreateCustomer(phoneNumber);
    const userId = user.id;

    const session = await this.sessionStore.getOrCreate(userId);

    // ── Route operator messages first ──────────────────────────────────────
    const operatorRecord = await this.prisma.operator.findUnique({
      where: { phoneNumber },
    });

    if (operatorRecord) {
      logger.info('whatsapp: routed to operator flow', {
        phoneNumber, userId, message, sessionState: session.state, rescueRequestId: session.rescueRequestId,
      });
      return this.operatorFlow.handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord);
    }

    return this.customerFlow.handleCustomerMessage(
      phoneNumber, userId, message, rawMessage, latitude, longitude, sharedAddress, session, body,
    );
  }
}
