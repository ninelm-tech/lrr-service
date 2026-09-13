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
});
