import { DepositReminderCheck } from '../../src/rescue-request/reconciler/checks/deposit-reminder.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

const MINUTE = 60_000;
const PAY_URL = 'https://checkout.paystack.com/abc123';

describe('DepositReminderCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: DepositReminderCheck;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new DepositReminderCheck(prisma, twilio as never);
  });

  /** `minutesLeft` before the deposit deadline. */
  async function withWindow(minutesLeft: number, remindersSent = 0) {
    const customer = await createCustomer(prisma);
    return createRequest(prisma, customer.id, {
      status: 'WAITING_FOR_DEPOSIT',
      depositWindowExpiresAt: new Date(Date.now() + minutesLeft * MINUTE),
      depositRemindersSent: remindersSent,
      depositPaymentUrl: PAY_URL,
    });
  }

  it('sends nothing before the first mark (more than 25 minutes left)', async () => {
    await withWindow(28);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends the first reminder once 25 minutes remain', async () => {
    const request = await withWindow(24);

    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const after = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(after?.depositRemindersSent).toBe(1);
  });

  it('includes the payment link, so the nudge is one tap', async () => {
    await withWindow(24);

    await check.run(new Date());

    const [, body] = twilio.sendWhatsAppMessage.mock.calls[0] as [
      string,
      string,
    ];
    expect(body).toContain(PAY_URL);
  });

  it('still nudges when no link was stored, rather than going silent', async () => {
    const customer = await createCustomer(prisma);
    await createRequest(prisma, customer.id, {
      status: 'WAITING_FOR_DEPOSIT',
      depositWindowExpiresAt: new Date(Date.now() + 24 * MINUTE),
      depositPaymentUrl: null,
    });

    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a reminder already sent', async () => {
    await withWindow(24, 1);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends ONE message after downtime, not one per missed mark', async () => {
    const request = await withWindow(3, 0); // all three marks are overdue

    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const after = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(after?.depositRemindersSent).toBe(3);
  });

  it('sends nothing once the window has already expired — cancellation handles it', async () => {
    await withWindow(-5, 0);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends once when two ticks run concurrently', async () => {
    await withWindow(24);
    await Promise.all([check.run(new Date()), check.run(new Date())]);
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});
