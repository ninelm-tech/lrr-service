import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackService } from '../../src/integrations/paystack/paystack.service';
import { TwilioService } from '../../src/integrations/twilio/twilio.service';
import { PlatformConfigService } from '../../src/platform-config/platform-config.service';
import { PaymentEventsService } from '../../src/rescue-request/payment-events.service';
import { RescueRequestSharedService } from '../../src/rescue-request/rescue-request-shared.service';
import { WhatsAppSessionStore } from '../../src/rescue-request/state/whatsapp-session.store';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PaystackCustomerService } from '../../src/payment/paystack-customer.service';
import { OperatorService } from '../../src/operator/operator.service';
import {
  truncateAll,
  createCustomer,
  createOperator,
  createRequest,
  createOffer,
} from './factories';

describe('RescueRequestAdminService.detailForUser — mediaLinks filter (integration)', () => {
  let prisma: PrismaService;
  let service: RescueRequestAdminService;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  beforeEach(async () => {
    // mediaLinks/media both gate on this being set — mirrors production,
    // where it always is; unset in the test environment otherwise.
    process.env.API_BASE_URL = 'https://api.example.com';
    await truncateAll(prisma);
    service = new RescueRequestAdminService(
      prisma,
      {} as unknown as PaystackService, // unused by detailForUser
      {} as unknown as TwilioService, // unused by detailForUser
      {
        getConfig: () =>
          Promise.resolve({ serviceFeePercent: 10, depositPercent: 10 }),
      } as unknown as PlatformConfigService,
      {} as unknown as PaymentEventsService, // unused by detailForUser
      {} as unknown as DispatchService, // unused by detailForUser
      {} as unknown as RescueRequestSharedService, // unused by detailForUser
      {} as unknown as WhatsAppSessionStore, // unused by detailForUser
      {} as unknown as PaymentLedgerService, // unused by detailForUser
      {} as unknown as PaystackCustomerService, // unused by detailForUser
      {} as never,
      {} as never, // PayoutService — unused by detailForUser
    );
  });

  it('mediaLinks only ever contains INITIAL-context media, even when COMPLETION and DISPUTE rows exist for the same request', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'COMPLETED',
      assignedOperatorId: operator.id,
    });

    const initial = await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-initial',
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-completion',
        contentType: 'image/jpeg',
        context: 'COMPLETION',
        uploadedByRole: 'OPERATOR',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-dispute',
        contentType: 'image/jpeg',
        context: 'DISPUTE',
        uploadedByRole: 'CUSTOMER',
      },
    });

    const result = await service.detailForUser(
      { role: 'SUPER_ADMIN', userId: 'admin-1' },
      request.id,
    );

    expect(result.data.mediaLinks).toHaveLength(1);
    expect(result.data.mediaLinks[0]).toContain(initial.id);
    expect(result.data.media).toHaveLength(3);
  });
});

describe('DispatchService.listMyPendingOffers — mediaLinks filter (integration)', () => {
  let prisma: PrismaService;
  let service: DispatchService;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  beforeEach(async () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    await truncateAll(prisma);
    service = new DispatchService(
      prisma,
      {} as unknown as TwilioService, // unused by listMyPendingOffers
      {} as unknown as OperatorService, // unused by listMyPendingOffers
      {} as unknown as PlatformConfigService, // unused by listMyPendingOffers
      {} as unknown as WhatsAppSessionStore, // unused by listMyPendingOffers
      {} as unknown as RescueRequestSharedService, // unused by listMyPendingOffers
      {
        findActiveOperatorIdsForUser: async (userId: string) => {
          const memberships = await prisma.operatorMember.findMany({
            where: { userId },
            select: { operatorId: true },
          });
          return memberships.map((membership) => membership.operatorId);
        },
      } as never,
    );
  });

  it("a pending offer's request.mediaLinks only ever contains INITIAL-context media", async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    await createOffer(prisma, request.id, operator.id);

    const initial = await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-initial',
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    // A DISPATCHING request can't actually have COMPLETION/DISPUTE media
    // yet in real use (see this plan's Global Constraints on
    // buildMediaLinksSection) — created directly here anyway, bypassing
    // the WhatsApp flow, specifically so this test proves the query filter
    // itself is correct rather than relying on the state machine to keep
    // it out of reach.
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-completion',
        contentType: 'image/jpeg',
        context: 'COMPLETION',
        uploadedByRole: 'OPERATOR',
      },
    });

    // operatorMember rows aren't created by the createOperator/createOffer
    // factories — create the membership linking a fresh operator user to
    // this operator directly, matching what listMyPendingOffers queries by.
    const operatorUser = await createCustomer(prisma);
    await prisma.operatorMember.create({
      data: {
        userId: operatorUser.id,
        operatorId: operator.id,
        role: 'OWNER',
      },
    });

    const result = await service.listMyPendingOffers(operatorUser.id);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].request.mediaLinks).toHaveLength(1);
    expect(result.data[0].request.mediaLinks[0]).toContain(initial.id);
  });
});
