import { StalledConfirmationCheck } from '../../src/rescue-request/reconciler/checks/stalled-confirmation.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

describe('StalledConfirmationCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let config: { getConfig: jest.Mock };
  let check: StalledConfirmationCheck;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    config = {
      getConfig: jest
        .fn()
        .mockResolvedValue({ disputeAlertPhoneNumber: '+2348000000000' }),
    };
    check = new StalledConfirmationCheck(
      prisma,
      twilio as never,
      config as never,
    );
  });

  async function awaitingConfirmation(
    offsetMs: number,
    overrides: Record<string, unknown> = {},
  ) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    return createRequest(prisma, customer.id, {
      status: 'ARRIVED',
      assignedOperatorId: operator.id,
      confirmationDueAt: new Date(Date.now() + offsetMs),
      ...overrides,
    });
  }

  it('alerts staff once the confirmation is overdue', async () => {
    await awaitingConfirmation(-60_000);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the due date so it cannot alert twice', async () => {
    const request = await awaitingConfirmation(-60_000);

    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(
      (await prisma.rescueRequest.findUnique({ where: { id: request.id } }))
        ?.confirmationDueAt,
    ).toBeNull();
  });

  it('does not alert before the due date', async () => {
    await awaitingConfirmation(60_000);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not alert on a disputed request — the dispute flow owns it', async () => {
    await awaitingConfirmation(-60_000, { disputed: true });
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not alert on a request that already ended', async () => {
    await awaitingConfirmation(-60_000, { status: 'COMPLETED' });
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('alerts once when two ticks run concurrently', async () => {
    await awaitingConfirmation(-60_000);
    await Promise.all([check.run(new Date()), check.run(new Date())]);
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it('stays silent when no alert number is configured, rather than throwing', async () => {
    config.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });
    await awaitingConfirmation(-60_000);

    await expect(check.run(new Date())).resolves.toBe(1);

    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
