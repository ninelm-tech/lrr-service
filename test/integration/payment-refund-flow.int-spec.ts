import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackRefundResult } from '../../src/integrations/paystack/dto/paystack-outcome.dto';
import { deriveRefundStatus } from '../../src/rescue-request/domain/derive-payment-state';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

/**
 * Refunds, against a real database.
 *
 * Refunds are the one type with no reference of ours, so they have no
 * duplicate-reference protection: a second POST is simply a second refund.
 * That makes the retryability of each failure the load-bearing property —
 * and retryability now lives in exactly one place, the REFUND Payment row's
 * own status. The old separate depositRefundStatus claim is gone (Task 11);
 * the admin-facing status is derived from these same rows.
 */
describe('Refund submission protocol (integration)', () => {
  let prisma: PrismaService;
  let ledger: PaymentLedgerService;
  let service: RescueRequestAdminService;
  let refundTransaction: jest.Mock;

  beforeAll(() => {
    prisma = new PrismaService();
    ledger = new PaymentLedgerService(prisma);
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
      ledger,
      {
        customerFor: jest
          .fn()
          .mockResolvedValue({ code: 'cus_test', email: 'customer@lrr.ng' }),
      } as never,
      {} as never,
      {} as never,
    );
  });

  const refundOk = (status: string, id = 999): PaystackRefundResult => ({
    outcome: 'ok',
    data: { id, status },
  });

  const DEPOSIT = 500_000;

  /** A CANCELLED request with a succeeded deposit — the eligible case. */
  async function refundableRequest() {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'CANCELLED',
      depositAmount: DEPOSIT,
      assignedOperatorId: operator.id,
    });
    const deposit = await ledger.create({
      rescueRequestId: request.id,
      type: 'DEPOSIT',
      amount: DEPOSIT,
    });
    await ledger.claimForSubmission(deposit.id, new Date());
    await ledger.claimTerminal(deposit.id, { status: 'SUCCEEDED' });
    return { request, deposit };
  }

  const refundPayment = () =>
    prisma.payment.findFirstOrThrow({ where: { type: 'REFUND' } });

  /** The admin-facing status, derived exactly as the DTOs derive it. */
  async function derivedRefundStatus(requestId: string) {
    const request = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { payments: { select: { type: true, status: true } } },
    });
    return deriveRefundStatus(request.status, request.payments);
  }

  it("refunds against the deposit payment's OWN reference, with the bare id as merchant_note", async () => {
    const { request, deposit } = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('pending'));

    await service.refundDeposit(request.id);

    const payment = await refundPayment();
    expect(refundTransaction).toHaveBeenCalledWith({
      transaction: `DEP_${deposit.id}`,
      amount: DEPOSIT,
      merchantNote: payment.id,
    });
    expect(payment.providerRef).toBe('refund:999');
  });

  it('never fails a refund on an ambiguous error — a second attempt would refund twice', async () => {
    const { request } = await refundableRequest();
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
    // SUBMITTED reads as PENDING (non-retryable) to the admin, whether or
    // not the row is the caller's own claim.
    expect(await derivedRefundStatus(request.id)).toBe('PENDING');
  });

  it('refuses a second refund while one is in flight, via the derived eligibility check', async () => {
    // A SUBMITTED refund reads as PENDING, which the eligibility check
    // rejects before ever reaching paymentLedger.create() — the in-flight
    // partial unique index is a second, independent guard behind it, for
    // the rarer case of two calls passing this read simultaneously.
    const { request } = await refundableRequest();
    refundTransaction.mockResolvedValue({
      outcome: 'ambiguous',
      message: 'socket hang up',
    });
    await service.refundDeposit(request.id).catch(() => undefined);
    refundTransaction.mockClear();

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'Not eligible for refund',
    );
    expect(refundTransaction).not.toHaveBeenCalled();
    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('permits a retry after a rejected refund — a failed row is history, not a claim', async () => {
    const { request } = await refundableRequest();
    refundTransaction.mockResolvedValue({
      outcome: 'rejected',
      code: 'transaction_not_found',
      message: 'nope',
    });
    await service.refundDeposit(request.id).catch(() => undefined);

    expect((await refundPayment()).status).toBe('FAILED');
    // FAILED, not ELIGIBLE — the admin sees that an attempt was made and
    // didn't land. Both read as retryable to refundDeposit's own check
    // (see deriveRefundStatus), so the retry below still succeeds.
    expect(await derivedRefundStatus(request.id)).toBe('FAILED');

    refundTransaction.mockResolvedValue(refundOk('pending', 1000));
    await expect(service.refundDeposit(request.id)).resolves.toBeUndefined();

    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(2);
  });

  it('does not claim SUCCEEDED from the POST, even when it says processed', async () => {
    const { request } = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('processed'));

    await service.refundDeposit(request.id);

    // Only the refund.processed webhook or verification may settle it.
    expect((await refundPayment()).status).toBe('SUBMITTED');
  });

  it('blocks a needs-attention refund and keeps it non-retryable', async () => {
    const { request } = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('needs-attention'));

    await service.refundDeposit(request.id);

    const payment = await refundPayment();
    expect(payment.status).toBe('BLOCKED');
    expect(payment.blockReason).toBe('NEEDS_CUSTOMER_DETAILS');
    // The refund exists at Paystack — retrying would create a second one.
    // BLOCKED reads the same as an active refund: PENDING to the admin.
    expect(await derivedRefundStatus(request.id)).toBe('PENDING');
  });

  it('fails the row when the refund body says failed, and it stays retryable', async () => {
    const { request } = await refundableRequest();
    refundTransaction.mockResolvedValue(refundOk('failed'));

    await service.refundDeposit(request.id);

    expect((await refundPayment()).status).toBe('FAILED');
    expect(await derivedRefundStatus(request.id)).toBe('FAILED');

    refundTransaction.mockResolvedValue(refundOk('pending', 1234));
    await expect(service.refundDeposit(request.id)).resolves.toBeUndefined();
    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(2);
  });

  it('creates no Payment row at all when there is no succeeded deposit to refund', async () => {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'CANCELLED',
    });

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'Not eligible for refund',
    );

    expect(await prisma.payment.count()).toBe(0);
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it('creates no Payment row when the request was never CANCELLED, even with a succeeded deposit', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'COMPLETED',
      assignedOperatorId: operator.id,
    });
    await ledger.create({
      rescueRequestId: request.id,
      type: 'DEPOSIT',
      amount: DEPOSIT,
    });

    await expect(service.refundDeposit(request.id)).rejects.toThrow(
      'Not eligible for refund',
    );
    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(0);
  });

  it('reads NONE for an untouched request — no succeeded deposit, not cancelled', async () => {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });

    expect(await derivedRefundStatus(request.id)).toBe('NONE');
  });
});
