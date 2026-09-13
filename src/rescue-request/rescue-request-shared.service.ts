import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { UserRole } from '@prisma/client';

/**
 * Small shared helpers with no WhatsApp-flow state of their own, used by
 * two or more of the rescue-request services — kept here instead of on any
 * one of them so none has to depend on a sibling just to resolve a user or
 * format a location string.
 */
@Injectable()
export class RescueRequestSharedService {
  private readonly DEPOSIT_REMINDER_MARKS_MS = [5, 15, 25].map(
    (m) => m * 60 * 1000,
  );
  private readonly DEPOSIT_WINDOW_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocodingService: GeocodingService,
    private readonly twilioService: TwilioService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where: { phoneNumber },
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

  /**
   * Ends any masked chat relay left open on a request that has just reached
   * a terminal state, telling both parties it's over.
   *
   * relayTarget is deliberately orthogonal to session state and is otherwise
   * only cleared by an explicit END CHAT. Since the relay branch runs ahead
   * of every other command in both flows, a job that ends mid-chat leaves
   * both parties permanently talking into a dead job: the operator can't
   * quote, send ARRIVED/DONE or rate, and the customer can't send SOS — or
   * even CANCEL, which the relay swallows too. Neither can get out
   * unprompted, so every path to a terminal status must call this.
   *
   * Best-effort by design: this is called from flows (payment confirmation,
   * cancellation) that must not fail because a courtesy message didn't send.
   */
  async endRelayForEndedRequest(rescueRequestId: string): Promise<void> {
    try {
      const request = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        include: { customer: true, assignedOperator: true },
      });
      if (!request) return;

      const phones: string[] = [];
      const userIds: string[] = [request.customerId];
      if (request.customer?.phoneNumber)
        phones.push(request.customer.phoneNumber);

      if (request.assignedOperator?.phoneNumber) {
        const operatorUser = await this.findOrCreateCustomer(
          request.assignedOperator.phoneNumber,
        );
        userIds.push(operatorUser.id);
        phones.push(request.assignedOperator.phoneNumber);
      }

      const cleared = await this.sessionStore.clearRelayTargets(userIds);
      if (cleared === 0) return; // no relay was open — don't message anyone

      await Promise.all(
        phones.map((phone) =>
          this.twilioService.sendWhatsAppMessage(
            phone,
            `Chat ended — this job is now closed.`,
          ),
        ),
      );
    } catch (error) {
      console.error('Failed to end chat relay for ended request:', error);
    }
  }
}
