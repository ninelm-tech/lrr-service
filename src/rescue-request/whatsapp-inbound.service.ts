import { Injectable } from '@nestjs/common';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { parseWhatsAppSender } from '../common/whatsapp-sender-identity.util';

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

  async handleIncomingWhatsAppMessage(
    body: Record<string, any>,
  ): Promise<string> {
    // From always carries whatsapp:-prefixed either a real phone number or
    // (once the sender has set a WhatsApp username) a BSUID; ExternalUserId
    // carries the BSUID on every webhook regardless. See
    // parseWhatsAppSender for the exact precedence.
    const parsed = parseWhatsAppSender(
      String(body.From || ''),
      body.ExternalUserId ? String(body.ExternalUserId) : undefined,
    );
    // A sender resolving to neither a phone nor a BSUID (parseWhatsAppSender's
    // "matches neither shape" case) is a malformed/unrecognizable webhook —
    // reject it before ever creating a User for it. Letting it through would
    // create an identity-less row with no phone and no BSUID, which every
    // later send to that "customer" has no real address for.
    if (!parsed.phoneNumber && !parsed.externalUserId) {
      throw new Error(
        `whatsapp: unresolvable sender — From=${String(body.From)} ExternalUserId=${String(body.ExternalUserId)}`,
      );
    }
    const rawMessage = String(body.Body || '').trim();
    const message = rawMessage.toLowerCase();
    const latitude = body.Latitude ? Number(body.Latitude) : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;
    // Present when a "search for a place" share includes WhatsApp's own
    // formatted address/place name — absent for a bare "current location" pin.
    const sharedAddress = body.Address
      ? String(body.Address).trim()
      : undefined;

    // Structured, not console.log — plain console.log on this path was never
    // shipped to Sentry (confirmed 2026-08-25 while investigating an
    // "operator stuck after ARRIVED" report with zero trace of the inbound
    // message anywhere), so this route had no diagnosability at all.
    logger.info('whatsapp: inbound message', {
      phoneNumber: parsed.phoneNumber,
      externalUserId: parsed.externalUserId,
      message,
      latitude,
      longitude,
    });

    // Always resolve (or create) a User for this sender. Passively captures
    // the BSUID<->phone link whenever both are visible on this message —
    // see RescueRequestSharedService.findOrCreateBySender.
    const user = await this.sharedService.findOrCreateBySender(parsed);
    const userId = user.id;

    const session = await this.sessionStore.getOrCreate(userId);

    // ── Route operator messages first ──────────────────────────────────────
    // Matched purely by phone: does this exact WhatsApp account (identified
    // by `user`, resolved above — by BSUID if currently masked) carry the
    // same phoneNumber as a registered Operator? `user.phoneNumber` is
    // whatever this account last showed unmasked (passive capture never
    // clears it), so this recognizes an already-registered operator who has
    // since gone masked without needing to re-identify by phone right now.
    //
    // Deliberately NOT based on OperatorMember/staff-login identity — that
    // system tracks who can act for an operator in the admin portal (keyed
    // on a personal login phone, which this product lets differ from the
    // operator's own WhatsApp dispatch line), a completely different axis
    // from "which phone number does WhatsApp dispatch run through."
    const operatorRecord = user.phoneNumber
      ? await this.prisma.operator.findUnique({
          where: { phoneNumber: user.phoneNumber },
        })
      : null;

    if (operatorRecord) {
      if (!operatorRecord.whatsappEnabled) {
        // A registered operator who went off-platform (or never had
        // WhatsApp) has no business driving operator commands — and must
        // not fall through to the customer flow either, which would give
        // this phone number a second, conflicting identity.
        logger.info('whatsapp: blocked non-WhatsApp operator at the router', {
          phoneNumber: user.phoneNumber,
          userId,
        });
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>This operator line is not WhatsApp-enabled — please contact LRR staff.</Message>\n</Response>`;
      }
      logger.info('whatsapp: routed to operator flow', {
        phoneNumber: user.phoneNumber,
        userId,
        message,
        sessionState: session.state,
        rescueRequestId: session.rescueRequestId,
      });
      return this.operatorFlow.handleOperatorMessage(
        operatorRecord.phoneNumber!,
        userId,
        message,
        rawMessage,
        session,
        {
          id: operatorRecord.id,
          businessName: operatorRecord.businessName,
          phoneNumber: operatorRecord.phoneNumber!,
        },
        body,
      );
    }

    // Everyone else — a phone-matched non-operator (today's customer path,
    // unchanged) or an unmatched BSUID sender (a brand-new or returning
    // customer whose account currently shows no phone number; see
    // findOrCreateBySender) — goes to the customer flow. No alert, no
    // blocking reply: a BSUID the router has never seen before is
    // indistinguishable from a new customer at this point, by construction.
    return this.customerFlow.handleCustomerMessage(
      parsed.phoneNumber ?? parsed.externalUserId!,
      userId,
      message,
      rawMessage,
      latitude,
      longitude,
      sharedAddress,
      session,
      body,
    );
  }
}
