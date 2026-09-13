import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackRefundResult } from '../../src/integrations/paystack/dto/paystack-outcome.dto';
import { createCustomer, createRequest, truncateAll } from './factories';

/**
 * Refunds, against a real database.
 *
 * Refunds are the one type with no reference of ours, so they have no
 * duplicate-reference protection: a second POST is simply a second refund.
 * That makes the retryability of each failure the load-bearing property, and
 * retryability lives in two places at once — the Payment row's status and the
 * request's depositRefundStatus. These tests check them together, because a
 * disagreement between them is what would let an admin refund twice.
 */
describe('Refund submission protocol (integration)', () => {
  let prisma: PrismaService;
  let service: RescueRequestAdminService;
  let refundTransaction: jest.Mock;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    refundTransaction = jest.fn();

    service = new RescueRequestAdminService(
      prisma,
      { refundTransaction } as never,
      { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { clear: jest.fn() } as never,
      new PaymentLedgerService(prisma),
    );
  });

  const refundOk = (status: string, id = 999): PaystackRefundResult => ({
    outcome: 'ok',
    data: { id, status },
  });

  const DEPOSIT = 500_000;

  async function refundableRequest() {
    const customer = await createCustomer(prisma);
    return createRequest(prisma, customer.id, {
      status: 'CANCELLED',
      depositPaid: true,
      depositAmount: DEPOSIT,
      depositReference: 'DEP_ref_1',
      depositRefundStatus: 'ELIGIBLE',
    });
  }

  const refundPayment = () =>
    prisma.payment.findFirstOrThrow({ where: { type: 'REFUND' } });

  const reloadRequest = (id: string) =>
    prisma.rescueRequest.findUniqueOrThrow({ where: { id } });

  it('sends the bare Payment.id as merchant_note, not a formatted reference', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('pending'));

    await service.refundDeposit(request.id);

    const payment = await refundPayment();
    expect(refundTransaction).toHaveBeenCalledWith({
      transaction: 'DEP_ref_1',
      amount: DEPOSIT,
      merchantNote: payment.id,
    });
    // referenceFor gives refunds '' precisely so this cannot be confused for
    // a reference Paystack would accept.
    expect(payment.providerRef).toBe('refund:999');
  });

  it('never fails a refund on an ambiguous error — a second attempt would refund twice', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue({
      outcome: 'ambiguous',
      message: 'socket hang up',
    });

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'Do not retry yet',
    );

    const payment = await refundPayment();
    expect(payment.status).toBe('SUBMITTED');
    expect(payment.failureReason).toBeNull();
    // PENDING is the non-retryable state — the admin claim stays held.
    expect((await reloadRequest(request.id)).depositRefundStatus).toBe(
      'PENDING',
    );
  });

  it('refuses a second refund while one is in flight, and does not call Paystack', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue({
      outcome: 'ambiguous',
      message: 'socket hang up',
    });
    await service.refundDeposit(request.id).catch(() => undefined);

    // The request claim alone would block this. Force it open so the test
    // exercises the ledger index rather than the claim, since the index is
    // the guard that survives a status being edited by hand.
    await prisma.rescueRequest.update({
      where: { id: request.id },
      data: { depositRefundStatus: 'FAILED' },
    });
    refundTransaction.mockClear();

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'A refund is already in progress',
    );
    expect(refundTransaction).not.toHaveBeenCalled();
    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('permits a retry after a rejected refund — a failed row is history, not a claim', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue({
      outcome: 'rejected',
      code: 'transaction_not_found',
      message: 'nope',
    });
    await service.refundDeposit(request.id).catch(() => undefined);

    expect((await refundPayment()).status).toBe('FAILED');
    // Released, because a definitive rejection means nothing was created.
    expect((await reloadRequest(request.id)).depositRefundStatus).toBe(
      'FAILED',
    );

    refundTransaction.mockResolvedValue(refundOk('pending', 1000));
    await expect(service.refundDeposit(request.id)).resolves.toBeUndefined();

    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(2);
  });

  it('does not claim SUCCEEDED from the POST, even when it says processed', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('processed'));

    await service.refundDeposit(request.id);

    // Only the refund.processed webhook or verification may settle it.
    expect((await refundPayment()).status).toBe('SUBMITTED');
  });

  it('blocks a needs-attention refund and keeps it non-retryable', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('needs-attention'));

    await service.refundDeposit(request.id);

    const payment = await refundPayment();
    expect(payment.status).toBe('BLOCKED');
    expect(payment.blockReason).toBe('NEEDS_CUSTOMER_DETAILS');
    // The refund exists at Paystack — retrying would create a second one.
    expect((await reloadRequest(request.id)).depositRefundStatus).toBe(
      'PENDING',
    );
  });

  it('fails the row and releases the claim when the refund body says failed', async () => {
    const request = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('failed'));

    await service.refundDeposit(request.id);

    expect((await refundPayment()).status).toBe('FAILED');
    expect((await reloadRequest(request.id)).depositRefundStatus).toBe(
      'FAILED',
    );
  });

  it('creates no Payment row at all when the request is not refund-eligible', async () => {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'CANCELLED',
      depositRefundStatus: 'NONE',
    });

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'Not eligible for refund',
    );

    expect(await prisma.payment.count()).toBe(0);
    expect(refundTransaction).not.toHaveBeenCalled();
  });
});
