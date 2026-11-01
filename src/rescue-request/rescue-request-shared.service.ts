import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { Prisma, User, UserRole } from '@prisma/client';
import { ParsedWhatsAppSender } from '../common/whatsapp-sender-identity.util';
import { toWhatsAppDestination } from '../common/phone.util';

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

  async findOrCreateCustomer(
    phoneNumber: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return client.user.upsert({
      where: { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }

  /**
   * Resolves the sender of an inbound WhatsApp message to a User, passively
   * linking BSUID<->phone whenever both are visible on the same message —
   * this is what lets a returning sender (by either identifier) resolve
   * back to the same account instead of a duplicate. See the WhatsApp
   * username/BSUID identity design doc for the full rationale.
   */
  async findOrCreateBySender(parsed: ParsedWhatsAppSender): Promise<User> {
    if (parsed.phoneNumber) {
      const byPhone = await this.prisma.user.findUnique({
        where: { phoneNumber: parsed.phoneNumber },
      });
      if (byPhone) {
        if (
          parsed.externalUserId &&
          byPhone.whatsappExternalUserId !== parsed.externalUserId
        ) {
          return this.prisma.$transaction(async (tx) => {
            // The same WhatsApp account may already be known under a
            // DIFFERENT row — e.g. a BSUID-only row created while this
            // account was masked, before it ever showed this phone number.
            // Clear the BSUID off that other row first, in the same
            // transaction, so the unique constraint doesn't reject moving
            // it onto byPhone below. Mirrors the identical collision
            // handling the REQUEST_CONTACT_INFO flow uses for the same
            // "same person, reuniting two rows" case.
            await tx.user.updateMany({
              where: {
                whatsappExternalUserId: parsed.externalUserId,
                id: { not: byPhone.id },
              },
              data: { whatsappExternalUserId: null },
            });
            return tx.user.update({
              where: { id: byPhone.id },
              data: { whatsappExternalUserId: parsed.externalUserId },
            });
          });
        }
        return byPhone;
      }

      if (parsed.externalUserId) {
        const byExternalUserId = await this.prisma.user.findUnique({
          where: { whatsappExternalUserId: parsed.externalUserId },
        });
        if (byExternalUserId) {
          return this.prisma.user.update({
            where: { id: byExternalUserId.id },
            data: { phoneNumber: parsed.phoneNumber },
          });
        }
      }

      try {
        return await this.prisma.user.create({
          data: {
            phoneNumber: parsed.phoneNumber,
            whatsappExternalUserId: parsed.externalUserId,
            role: UserRole.CUSTOMER,
          },
        });
      } catch (error) {
        // Twilio redelivers on a slow/timeout response, so the same
        // brand-new sender's message can arrive twice concurrently — both
        // calls see "not found" above, then race to create. The loser
        // doesn't get an error surfaced to the customer; it re-fetches the
        // row the winner just committed.
        if (this.isUniqueConstraint(error, 'phoneNumber')) {
          const winner = await this.prisma.user.findUnique({
            where: { phoneNumber: parsed.phoneNumber },
          });
          if (winner) return winner;
        }
        if (
          parsed.externalUserId &&
          this.isUniqueConstraint(error, 'whatsappExternalUserId')
        ) {
          const winner = await this.prisma.user.findUnique({
            where: { whatsappExternalUserId: parsed.externalUserId },
          });
          if (winner) return winner;
        }
        throw error;
      }
    }

    if (parsed.externalUserId) {
      const byExternalUserId = await this.prisma.user.findUnique({
        where: { whatsappExternalUserId: parsed.externalUserId },
      });
      if (byExternalUserId) return byExternalUserId;
    }

    try {
      return await this.prisma.user.create({
        data: {
          phoneNumber: null,
          whatsappExternalUserId: parsed.externalUserId,
          role: UserRole.CUSTOMER,
        },
      });
    } catch (error) {
      // Same concurrent-redelivery race as above, for a BSUID-only sender.
      if (this.isUniqueConstraint(error, 'whatsappExternalUserId')) {
        const winner = await this.prisma.user.findUnique({
          where: { whatsappExternalUserId: parsed.externalUserId! },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private isUniqueConstraint(error: unknown, field: string): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target = error.meta?.target;
    if (Array.isArray(target)) return target.includes(field);
    if (typeof target === 'string') return target.includes(field);
    return false;
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
      if (request.customer)
        phones.push(toWhatsAppDestination(request.customer));

      if (request.assignedOperator?.phoneNumber) {
        const operatorUser = await this.findOrCreateCustomer(
          request.assignedOperator.phoneNumber,
        );
        userIds.push(operatorUser.id);
        // The relay side still gets cleared below regardless — a non-
        // WhatsApp operator can never have actually opened one (Task 7's
        // CHAT DRIVER guard), so this is a defensive no-op for them, not a
        // behavior change. Only the "chat ended" message itself is gated.
        if (request.assignedOperator.whatsappEnabled) {
          phones.push(request.assignedOperator.phoneNumber);
        }
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
