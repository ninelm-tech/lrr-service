import { PayoutService } from '../../src/payout/payout.service';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackTransferResult } from '../../src/integrations/paystack/dto/paystack-outcome.dto';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * Payouts, against a real database.
 *
 * The outbound direction is where a mistake costs the most: a payout wrongly
 * marked FAILED makes a fresh reference legal, and a fresh reference is a
 * second real transfer. These tests pin the three outcomes that decide it.
 */
describe('Payout submission protocol (integration)', () => {
  let prisma: PrismaService;
  let service: PayoutService;
  let initiateTransfer: jest.Mock;
  let checkBalance: jest.Mock;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    initiateTransfer = jest.fn();
    checkBalance = jest.fn().mockResolvedValue(100_000_000);

    service = new PayoutService(
      prisma,
      { initiateTransfer, checkBalance } as never,
      {
        sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
        sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
      } as never,
      new PaymentLedgerService(prisma),
    );
  });

  const transferOk = (status: string): PaystackTransferResult => ({
    outcome: 'ok',
    data: { status, transfer_code: 'TRF_abc123' },
  });

  const AMOUNT = 250_000;

  async function payableJob(withBankDetails = true) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    if (withBankDetails) {
      await prisma.operator.update({
        where: { id: operator.id },
        data: { paystackRecipientCode: 'RCP_existing' },
      });
    }
    const request = await createRequest(prisma, customer.id, {
      status: 'COMPLETED',
      assignedOperatorId: operator.id,
    });
    return { operator, request };
  }

  const run = (requestId: string, operatorId: string) =>
    service.createAndProcessPayout(requestId, operatorId, AMOUNT);

  const payoutPayment = () =>
    prisma.payment.findFirstOrThrow({ where: { type: 'PAYOUT' } });

  it('leaves a transfer returning otp BLOCKED, not SUBMITTED — polling would never finish it', async () => {
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('otp'));

    await run(request.id, operator.id);

    const payment = await payoutPayment();
    expect(payment.status).toBe('BLOCKED');
    expect(payment.blockReason).toBe('AWAITING_OTP');
    // Recorded even though verification keys on our own reference.
    expect(payment.providerRef).toBe('trf:TRF_abc123');
  });

  it('retries an AWAITING_OTP payout by resubmitting the same row and reference', async () => {
    // Retry must actually reach Paystack whenever the button is shown —
    // silently refusing to resubmit an otp-blocked row just leaves it
    // stuck forever, since nothing else ever revisits it. Reusing the same
    // row/reference is what keeps this safe: the in-flight unique index
    // still permits only one live PAYOUT row per request, and Paystack
    // itself rejects a reused reference as a duplicate rather than moving
    // money twice (see the "never re-sends" and "duplicate reference" cases
    // below/above).
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('otp'));
    await run(request.id, operator.id);
    const blocked = await payoutPayment();
    expect(blocked.status).toBe('BLOCKED');

    initiateTransfer.mockResolvedValue(transferOk('pending'));
    await service.retryPayout(blocked.id);

    expect(initiateTransfer).toHaveBeenCalledTimes(2);
    expect(await prisma.payment.count({ where: { type: 'PAYOUT' } })).toBe(1);
    const after = await payoutPayment();
    expect(after.id).toBe(blocked.id);
    expect(after.status).toBe('SUBMITTED');
    expect(after.blockReason).toBeNull();
  });

  it('maps abandoned to FAILED — the live bug', async () => {
    // OTP was never answered, so nothing moved and the transfer is dead.
    // Unlike a collection, where abandoned means "not paid yet".
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('abandoned'));

    await run(request.id, operator.id);

    const payment = await payoutPayment();
    expect(payment.status).toBe('FAILED');
    expect(payment.settledAt).not.toBeNull();
  });

  it('treats a duplicate reference as evidence the original landed, not as a rejection', async () => {
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue({
      outcome: 'rejected',
      code: 'duplicate_reference',
      message: 'Transfer reference has already been used',
    });

    await run(request.id, operator.id);

    const payment = await payoutPayment();
    expect(payment.status).toBe('SUBMITTED');
    expect(payment.failureReason).toBeNull();
  });

  it('does not claim SUCCEEDED even when the transfer body says success', async () => {
    // Only a webhook or verification may write SUCCEEDED. Trusting this
    // response would settle a payout Paystack can still reverse.
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('success'));

    await run(request.id, operator.id);

    expect((await payoutPayment()).status).toBe('SUBMITTED');
  });

  it('sends the ledger row id as the reference', async () => {
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('pending'));

    await run(request.id, operator.id);

    const payment = await payoutPayment();
    expect(initiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ reference: `payout_${payment.id}` }),
    );
  });

  it('blocks without sending anything when the operator has no bank details', async () => {
    const { operator, request } = await payableJob(false);

    await run(request.id, operator.id);

    const payment = await payoutPayment();
    expect(payment.status).toBe('BLOCKED');
    expect(payment.blockReason).toBe('NO_BANK_DETAILS');
    expect(initiateTransfer).not.toHaveBeenCalled();
  });

  it('resumes the same row on retry rather than inserting a sibling', async () => {
    // A block we caused ourselves never reached Paystack, so the attempt can
    // legitimately resume — and must, because the in-flight unique index
    // permits only one row per request and type.
    const { operator, request } = await payableJob(false);
    await run(request.id, operator.id);
    const blocked = await payoutPayment();

    await prisma.operator.update({
      where: { id: operator.id },
      data: { paystackRecipientCode: 'RCP_existing' },
    });
    initiateTransfer.mockResolvedValue(transferOk('pending'));

    await service.retryPayout(blocked.id);

    expect(await prisma.payment.count({ where: { type: 'PAYOUT' } })).toBe(1);
    const after = await payoutPayment();
    expect(after.id).toBe(blocked.id);
    expect(after.status).toBe('SUBMITTED');
    expect(after.blockReason).toBeNull();
  });

  it('never re-sends a transfer that is already in flight', async () => {
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('pending'));
    await run(request.id, operator.id);
    expect(initiateTransfer).toHaveBeenCalledTimes(1);

    // A second attempt for the same request finds the row SUBMITTED. The
    // money is already moving; a second transfer would pay twice.
    await run(request.id, operator.id);

    expect(initiateTransfer).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { type: 'PAYOUT' } })).toBe(1);
  });

  it('refuses to retry a stale FAILED row once a sibling has already succeeded', async () => {
    // The original attempt abandons and lands FAILED. A retry inserts a
    // fresh sibling with a new reference — that's the normal, expected
    // path — and THAT one later succeeds (e.g. via a webhook, simulated
    // here with a direct update since how it got there isn't what this
    // test is about). The old FAILED row must never become retryable
    // again just because it's individually a retryable status: a job can
    // have any number of dead attempts sitting next to the one that
    // actually landed.
    const { operator, request } = await payableJob();
    initiateTransfer.mockResolvedValue(transferOk('abandoned'));
    await run(request.id, operator.id);
    const failed = await payoutPayment();
    expect(failed.status).toBe('FAILED');

    initiateTransfer.mockResolvedValue(transferOk('pending'));
    await service.retryPayout(failed.id);
    expect(await prisma.payment.count({ where: { type: 'PAYOUT' } })).toBe(2);
    const fresh = await prisma.payment.findFirstOrThrow({
      where: { type: 'PAYOUT', id: { not: failed.id } },
    });
    await prisma.payment.update({
      where: { id: fresh.id },
      data: { status: 'SUCCEEDED', settledAt: new Date() },
    });

    initiateTransfer.mockClear();
    await expect(service.retryPayout(failed.id)).rejects.toThrow(
      'already succeeded',
    );

    expect(initiateTransfer).not.toHaveBeenCalled();
    expect(await prisma.payment.count({ where: { type: 'PAYOUT' } })).toBe(2);
  });
});
