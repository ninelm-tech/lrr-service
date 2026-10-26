import * as Sentry from '@sentry/node';
import { StuckOperatorJobCheck } from '../../src/rescue-request/reconciler/checks/stuck-operator-job.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

jest.mock('@sentry/node', (): typeof Sentry => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

describe('StuckOperatorJobCheck (integration)', () => {
  let prisma: PrismaService;
  let twilioService: { sendWhatsAppMessage: jest.Mock };
  let platformConfigService: { getConfig: jest.Mock };
  let check: StuckOperatorJobCheck;

  const thirtyFiveMinutesAgo = () => new Date(Date.now() - 35 * 60 * 1000);

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilioService = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
    };
    platformConfigService = {
      getConfig: jest
        .fn()
        .mockResolvedValue({ disputeAlertPhoneNumbers: ['+2348099999999'] }),
    };
    check = new StuckOperatorJobCheck(
      prisma,
      twilioService as never,
      platformConfigService as never,
    );
  });

  async function createStaleAssignedRequest(overrides: {
    status: string;
    operatorWhatsappEnabled: boolean;
    updatedAt: Date;
  }) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, {
      whatsappEnabled: overrides.operatorWhatsappEnabled,
    });
    const request = await createRequest(prisma, customer.id, {
      status: overrides.status,
      assignedOperatorId: operator.id,
      updatedAt: overrides.updatedAt,
    });
    return request;
  }

  it('alerts staff for an OPERATOR_ASSIGNED or ARRIVED request with a WhatsApp-enabled operator and no recent activity', async () => {
    const request = await createStaleAssignedRequest({
      status: 'OPERATOR_ASSIGNED',
      operatorWhatsappEnabled: true,
      updatedAt: thirtyFiveMinutesAgo(),
    });

    const acted = await check.run(new Date());

    expect(acted).toBe(1);
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.any(String),
      // formatJobRef takes the TAIL of the id (rescue-request-formatting.ts),
      // not the head — the brief's own comment flagged this as approximate.
      expect.stringContaining(request.id.slice(-6).toUpperCase()),
    );
  });

  it('does not alert for a request updated recently', async () => {
    await createStaleAssignedRequest({
      status: 'OPERATOR_ASSIGNED',
      operatorWhatsappEnabled: true,
      updatedAt: new Date(),
    });

    expect(await check.run(new Date())).toBe(0);
    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not alert twice for the same stale job on a second pass (idempotent, per ReconcilerCheck contract)', async () => {
    await createStaleAssignedRequest({
      status: 'OPERATOR_ASSIGNED',
      operatorWhatsappEnabled: true,
      updatedAt: thirtyFiveMinutesAgo(),
    });

    const firstPass = await check.run(new Date());
    const secondPass = await check.run(new Date());

    expect(firstPass).toBe(1);
    expect(secondPass).toBe(0);
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it('does not alert for an ARRIVED request whose operator is not WhatsApp-enabled', async () => {
    await createStaleAssignedRequest({
      status: 'ARRIVED',
      operatorWhatsappEnabled: false,
      updatedAt: thirtyFiveMinutesAgo(),
    });

    expect(await check.run(new Date())).toBe(0);
  });

  it('still claims the job (so it is not re-fetched every tick) but flags the misconfiguration via Sentry when disputeAlertPhoneNumbers is empty — no one is actually paged (multi-llm review finding, hotfix 2026-10-25)', async () => {
    platformConfigService.getConfig.mockResolvedValue({
      disputeAlertPhoneNumbers: [],
    });
    const request = await createStaleAssignedRequest({
      status: 'OPERATOR_ASSIGNED',
      operatorWhatsappEnabled: true,
      updatedAt: thirtyFiveMinutesAgo(),
    });
    const requestId: string = request.id;

    const acted = await check.run(new Date());

    expect(acted).toBe(1);
    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('disputeAlertPhoneNumbers'),
      expect.objectContaining({
        level: 'warning',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- createRequest's untyped overrides param (test/integration/factories.ts) widens its return to any; requestId is a real string, just not inferred as one
        extra: expect.objectContaining({ rescueRequestId: requestId }),
      }),
    );
  });
});
