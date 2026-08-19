import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RescueRequestService {
  constructor(
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly prisma: PrismaService,
    private readonly geocodingService: GeocodingService,
    @Inject(forwardRef(() => WhatsAppOperatorFlowService))
    private readonly operatorFlowService: WhatsAppOperatorFlowService,
    @Inject(forwardRef(() => WhatsAppCustomerFlowService))
    private readonly customerFlowService: WhatsAppCustomerFlowService,
  ) {}

  // ═══════════════════════════════════════════════════════
  //  WHATSAPP FLOW — incoming message handler
  // ═══════════════════════════════════════════════════════

  async handleIncomingWhatsAppMessage(body: Record<string, any>) {
    // Twilio always delivers E.164 with country code — just strip the whatsapp: prefix
    const phoneNumber: string = String(body.From || '').replace(/^whatsapp:/i, '');
    const rawMessage = String(body.Body || '').trim();
    const message = rawMessage.toLowerCase();
    const latitude  = body.Latitude  ? Number(body.Latitude)  : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;
    // Present when a "search for a place" share includes WhatsApp's own
    // formatted address/place name — absent for a bare "current location" pin.
    const sharedAddress = body.Address ? String(body.Address).trim() : undefined;

    console.log('Incoming WhatsApp message:', { phoneNumber, message, latitude, longitude });

    // Always resolve (or create) a User for this phone number.
    // Operators and customers both have a User record — this is our session key.
    const user = await this.findOrCreateCustomer(phoneNumber);
    const userId = user.id;

    const session = await this.sessionStore.getOrCreate(userId);

    // ── Route operator messages first ──────────────────────────────────────
    const operatorRecord = await this.prisma.operator.findUnique({
      where: { phoneNumber },
    });

    if (operatorRecord) {
      return this.operatorFlowService.handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord);
    }

    return this.customerFlowService.handleCustomerMessage(
      phoneNumber, userId, message, rawMessage, latitude, longitude, sharedAddress, session, body,
    );
  }

  // ══════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ══════════════════════════════════════════════════════

  async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where:  { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }

  /**
   * Operators were only ever given a raw Google Maps link for the pickup
   * point — no address, no area name, nothing readable without clicking
   * through. Reverse-geocodes so the message itself carries the full
   * picture (address if resolvable, map link always). Best-effort: a
   * failed/unconfigured geocode falls back to the map link alone rather
   * than blocking dispatch.
   */
  async formatLocationSection(lat: number, lon: number): Promise<string> {
    const address = await this.geocodingService.reverseGeocode(lat, lon);
    const mapLink = `https://maps.google.com/?q=${lat},${lon}`;
    return address ? `${address}\n📍 ${mapLink}` : mapLink;
  }
}
