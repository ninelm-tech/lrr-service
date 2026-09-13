import * as Sentry from '@sentry/node';
import { PaymentVerifyCheck } from '../../src/rescue-request/reconciler/checks/payment-verify.check';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MAX_VERIFY_ATTEMPTS } from '../../src/payment/payment.constants';
import { PaymentType } from '@prisma/client';
import {
  createCustomer,
  createOperator,
  createRequest,
  truncateAll,
} from './factories';

// @sentry/node's exports are not configurable, so jest.spyOn on the real
// module throws "Cannot redefine property" — the same reason unit specs
// mock it wholesale rather than spying on it.
jest.mock('@sentry/node', () => ({ captureMessage: jest.fn() }));

/**
 * The recovery check, against a real database.
 *
 * PENDING and SUBMITTED need opposite treatment, and the collection,
 * payout, and refund types each resolve a SUBMITTED row differently. These
 * tests pin every branch from the design's Testing list that concerns this
 * check specifically — the ledger's own CAS behaviour is already covered in
 * payment-ledger.int-spec.ts.
 */
describe('PaymentVerifyCheck (integration)', () => {
  let prisma: PrismaService;
  let ledger: PaymentLedgerService;
  let check: PaymentVerifyCheck;
  let paystack: {
    initializePayment: jest.Mock;
    initiateTransfer: jest.Mock;
    refundTransaction: jest.Mock;
    verifyTransaction: jest.Mock;
    verifyTransfer: jest.Mock;
    listRefunds: jest.Mock;
  };
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let paymentEvents: { confirmDeposit: jest.Mock; confirmBalance: jest.Mock };
  let payoutServiceMock: { notifyPayoutOutcome: jest.Mock };
  const captureMessage = Sentry.captureMessage as jest.Mock;

  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(() => {
    prisma = new PrismaService();
    ledger = new PaymentLedgerService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    paystack = {
      initializePayment: jest.fn(),
      initiateTransfer: jest.fn(),
      refundTransaction: jest.fn(),
      verifyTransaction: jest.fn(),
      verifyTransfer: jest.fn(),
      listRefunds: jest.fn(),
    };
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    paymentEvents = {
      confirmDeposit: jest.fn().mockResolvedValue(undefined),
      confirmBalance: jest.fn().mockResolvedValue(undefined),
    };
    payoutServiceMock = {
      notifyPayoutOutcome: jest.fn().mockResolvedValue(undefined),
    };
    check = new PaymentVerifyCheck(
      prisma,
      paystack as never,
      twilio as never,
      ledger,
      paymentEvents as never,
      payoutServiceMock as never,
      {
        customerFor: jest
          .fn()
          .mockResolvedValue({ code: 'cus_test', email: 'customer@lrr.ng' }),
      } as never,
    );
    captureMessage.mockClear();
  });

  async function seedRequest(overrides: Record<string, unknown> = {}) {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id, overrides);
    return { customer, request };
  }

  async function pendingPayment(
    type: PaymentType,
    requestId: string,
    opts: { amount?: number; operatorId?: string } = {},
  ) {
    return ledger.create({
      rescueRequestId: requestId,
      type,
      amount: opts.amount ?? 500_000,
      operatorId: opts.operatorId,
    });
  }

  /** A row already SUBMITTED — the state a lost response leaves behind. */
  async function submittedPayment(
    type: PaymentType,
    requestId: string,
    opts: {
      amount?: number;
      operatorId?: string;
      checkoutUrl?: string | null;
      verifyAttempts?: number;
    } = {},
  ) {
    const payment = await pendingPayment(type, requestId, opts);
    await ledger.claimForSubmission(payment.id, new Date());
    return prisma.payment.update({
      where: { id: payment.id },
      data: {
        verifyAfter: past(),
        checkoutUrl: opts.checkoutUrl ?? null,
        verifyAttempts: opts.verifyAttempts ?? 0,
      },
    });
  }

  const reload = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });

  // ── PENDING → initiate ──────────────────────────────────────────────────

  describe('PENDING: no call was ever made', () => {
    it('initiates a deposit, persists the checkout URL on the request, and sends it', async () => {
      const { request } = await seedRequest({ status: 'DISPATCHING' });
      await pendingPayment('DEPOSIT', request.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'ok',
        data: {
          authorization_url: 'https://paystack.test/pay/recovered',
          access_code: 'acc_1',
          reference: 'ref',
        },
      });

      const acted = await check.run(future());

      expect(acted).toBe(1);
      const payment = await prisma.payment.findFirstOrThrow();
      expect(payment.status).toBe('SUBMITTED');
      expect(payment.checkoutUrl).toBe('https://paystack.test/pay/recovered');

      // No RescueRequest.depositReference any more — the webhook and this
      // check both find the request via the Payment row's own
      // rescueRequestId. depositPaymentUrl alone is kept, for the deposit
      // reminder check to resend without a fresh Paystack call.
      const after = await prisma.rescueRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(after.depositPaymentUrl).toBe(
        'https://paystack.test/pay/recovered',
      );
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('https://paystack.test/pay/recovered'),
      );
    });

    it('initiates a balance payment and sends it, writing no RescueRequest field at all', async () => {
      const { request } = await seedRequest();
      await pendingPayment('BALANCE', request.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'ok',
        data: {
          authorization_url: 'https://paystack.test/pay/bal',
          access_code: 'acc_1',
          reference: 'ref',
        },
      });

      await check.run(future());

      // A balance link is only ever sent once, never resent from a stored
      // copy — unlike a deposit, there is no column for it to land in.
      const after = await prisma.rescueRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(after.depositPaymentUrl).toBeNull();
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('https://paystack.test/pay/bal'),
      );
    });

    it('fails a rejected recovered collection, and never sends anything', async () => {
      const { request } = await seedRequest();
      await pendingPayment('DEPOSIT', request.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'rejected',
        code: 'invalid_params',
        message: 'Invalid amount',
      });

      await check.run(future());

      expect((await prisma.payment.findFirstOrThrow()).status).toBe('FAILED');
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('leaves an ambiguous recovered collection SUBMITTED with no URL', async () => {
      const { request } = await seedRequest();
      await pendingPayment('DEPOSIT', request.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'timeout',
      });

      await check.run(future());

      const payment = await prisma.payment.findFirstOrThrow();
      expect(payment.status).toBe('SUBMITTED');
      expect(payment.checkoutUrl).toBeNull();
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('initiates a payout with its own reference — nobody to notify', async () => {
      const { request } = await seedRequest();
      const operator = await createOperator(prisma);
      await prisma.operator.update({
        where: { id: operator.id },
        data: { paystackRecipientCode: 'RCP_existing' },
      });
      await pendingPayment('PAYOUT', request.id, { operatorId: operator.id });
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'pending', transfer_code: 'TRF_1' },
      });

      await check.run(future());

      const payment = await prisma.payment.findFirstOrThrow();
      expect(paystack.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientCode: 'RCP_existing',
          reference: `payout_${payment.id}`,
        }),
      );
      expect(payment.status).toBe('SUBMITTED');
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it("initiates a refund against the deposit payment's OWN reference, with the bare id as merchant_note", async () => {
      const { request } = await seedRequest();
      const deposit = await ledger.create({
        rescueRequestId: request.id,
        type: 'DEPOSIT',
        amount: 500_000,
      });
      await ledger.claimForSubmission(deposit.id, new Date());
      await ledger.claimTerminal(deposit.id, { status: 'SUCCEEDED' });
      const refund = await pendingPayment('REFUND', request.id, {
        amount: 500_000,
      });
      paystack.refundTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { id: 999, status: 'pending' },
      });

      await check.run(future());

      expect(paystack.refundTransaction).toHaveBeenCalledWith({
        transaction: `DEP_${deposit.id}`,
        amount: 500_000,
        merchantNote: refund.id,
      });
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('escalates rather than guesses when a recovered refund has no succeeded deposit to refund against', async () => {
      const { request } = await seedRequest(); // no deposit at all
      await pendingPayment('REFUND', request.id);

      await check.run(future());

      expect(paystack.refundTransaction).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('succeeded deposit'),
        expect.anything(),
      );
      expect((await prisma.payment.findFirstOrThrow()).status).toBe(
        'SUBMITTED', // still claimed — the CAS ran even though initiate could not proceed
      );
    });

    it('when two callers race the PENDING → SUBMITTED CAS, exactly one calls Paystack', async () => {
      const { request } = await seedRequest();
      await pendingPayment('DEPOSIT', request.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'ok',
        data: {
          authorization_url: 'https://paystack.test/pay/x',
          access_code: 'a',
          reference: 'r',
        },
      });

      await Promise.all([check.run(future()), check.run(future())]);

      expect(paystack.initializePayment).toHaveBeenCalledTimes(1);
    });
  });

  // ── SUBMITTED: collections ───────────────────────────────────────────────

  describe('SUBMITTED collection: the unpayable-collection rule', () => {
    it('claims SUCCEEDED and persists fee/net from a real success verify', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: 'https://paystack.test/pay/x',
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'success', id: 778899, amount: 500_000, fees: 7_500 },
      });

      await check.run(future());

      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.providerRef).toBe('txn:778899');
      expect(after.providerFee).toBe(7_500);
      expect(after.netAmount).toBe(492_500);
    });

    it('fails a collection Paystack has never heard of', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: 'https://paystack.test/pay/x',
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'rejected',
        code: 'transaction_not_found',
      });

      await check.run(future());

      expect((await reload(payment.id)).status).toBe('FAILED');
    });

    it('fails an unpayable collection — Paystack has it, we never got the URL', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: null,
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'abandoned', id: 1, amount: 500_000 },
      });

      await check.run(future());

      expect((await reload(payment.id)).status).toBe('FAILED');
    });

    it('never fails a collection whose URL the customer may hold — resends and waits', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: 'https://paystack.test/pay/x',
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'abandoned', id: 1, amount: 500_000 },
      });
      const before = await reload(payment.id);

      await check.run(future());

      const after = await reload(payment.id);
      expect(after.status).toBe('SUBMITTED');
      expect(after.verifyAfter.getTime()).toBeGreaterThan(
        before.verifyAfter.getTime(),
      );
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('https://paystack.test/pay/x'),
      );
    });

    it('backs off on an ambiguous verify rather than guessing', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: 'https://paystack.test/pay/x',
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'timeout',
      });

      await check.run(future());

      expect((await reload(payment.id)).status).toBe('SUBMITTED');
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });

  // ── SUBMITTED: payouts ───────────────────────────────────────────────────

  describe('SUBMITTED payout: not-found is never definitive for outbound money', () => {
    async function payoutRequest() {
      const { request } = await seedRequest();
      const operator = await createOperator(prisma);
      await prisma.operator.update({
        where: { id: operator.id },
        data: { paystackRecipientCode: 'RCP_existing' },
      });
      return { request, operator };
    }

    it('claims SUCCEEDED on a real success verify', async () => {
      const { request, operator } = await payoutRequest();
      const payment = await submittedPayment('PAYOUT', request.id, {
        operatorId: operator.id,
      });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'success', transfer_code: 'TRF_1' },
      });

      await check.run(future());

      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.providerRef).toBe('trf:TRF_1');
    });

    it('blocks on otp rather than polling forever', async () => {
      const { request, operator } = await payoutRequest();
      const payment = await submittedPayment('PAYOUT', request.id, {
        operatorId: operator.id,
      });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'otp', transfer_code: 'TRF_1' },
      });

      await check.run(future());

      const after = await reload(payment.id);
      expect(after.status).toBe('BLOCKED');
      expect(after.blockReason).toBe('AWAITING_OTP');
    });

    it('re-submits the SAME reference on not-found rather than failing it', async () => {
      const { request, operator } = await payoutRequest();
      const payment = await submittedPayment('PAYOUT', request.id, {
        operatorId: operator.id,
      });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'not_found',
      });
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'pending', transfer_code: 'TRF_2' },
      });

      await check.run(future());

      expect(paystack.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ reference: `payout_${payment.id}` }),
      );
      const after = await reload(payment.id);
      expect(after.status).toBe('SUBMITTED'); // not FAILED
      expect(after.verifyAttempts).toBe(1);
    });

    it('treats a duplicate-reference rejection on re-submission as evidence the original landed', async () => {
      const { request, operator } = await payoutRequest();
      await submittedPayment('PAYOUT', request.id, { operatorId: operator.id });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'not_found',
      });
      paystack.initiateTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'duplicate_reference',
      });

      await check.run(future());

      const payment = await prisma.payment.findFirstOrThrow();
      expect(payment.status).toBe('SUBMITTED');
      expect(payment.failureReason).toBeNull();
    });

    it('escalates rather than re-submitting forever, once MAX_VERIFY_ATTEMPTS is reached', async () => {
      const { request, operator } = await payoutRequest();
      const payment = await submittedPayment('PAYOUT', request.id, {
        operatorId: operator.id,
        verifyAttempts: MAX_VERIFY_ATTEMPTS,
      });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'rejected',
        code: 'not_found',
      });

      await check.run(future());

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('max verify attempts'),
        expect.anything(),
      );
      expect((await reload(payment.id)).status).toBe('SUBMITTED');
    });

    it('backs off on an ambiguous verify rather than guessing', async () => {
      const { request, operator } = await payoutRequest();
      const payment = await submittedPayment('PAYOUT', request.id, {
        operatorId: operator.id,
      });
      paystack.verifyTransfer.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'timeout',
      });

      await check.run(future());

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect((await reload(payment.id)).status).toBe('SUBMITTED');
    });
  });

  // ── SUBMITTED: refunds ───────────────────────────────────────────────────

  describe('SUBMITTED refund: read-only recovery, never re-submitted', () => {
    async function refundWithSucceededDeposit(txnId = 778899) {
      const { request } = await seedRequest();
      const deposit = await ledger.create({
        rescueRequestId: request.id,
        type: 'DEPOSIT',
        amount: 500_000,
      });
      await ledger.claimForSubmission(deposit.id, new Date());
      await ledger.claimTerminal(
        deposit.id,
        { status: 'SUCCEEDED' },
        { providerRef: `txn:${txnId}` },
      );
      const refund = await submittedPayment('REFUND', request.id);
      return { request, refund };
    }

    it('adopts the refund whose merchant_note matches its id', async () => {
      const { refund } = await refundWithSucceededDeposit();
      paystack.listRefunds.mockResolvedValue({
        outcome: 'ok',
        data: [{ id: 42, status: 'processed', merchant_note: refund.id }],
      });

      await check.run(future());

      const after = await reload(refund.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.providerRef).toBe('refund:42');
    });

    it('ignores an unrelated refund on the same transaction', async () => {
      const { refund } = await refundWithSucceededDeposit();
      paystack.listRefunds.mockResolvedValue({
        outcome: 'ok',
        data: [
          {
            id: 42,
            status: 'processed',
            merchant_note: 'someone-elses-payment',
          },
        ],
      });

      await check.run(future());

      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('stays SUBMITTED with no match, and never calls refundTransaction', async () => {
      const { refund } = await refundWithSucceededDeposit();
      paystack.listRefunds.mockResolvedValue({ outcome: 'ok', data: [] });

      await check.run(future());

      expect(paystack.refundTransaction).not.toHaveBeenCalled();
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('blocks on needs-attention', async () => {
      const { refund } = await refundWithSucceededDeposit();
      paystack.listRefunds.mockResolvedValue({
        outcome: 'ok',
        data: [{ id: 42, status: 'needs-attention', merchant_note: refund.id }],
      });

      await check.run(future());

      const after = await reload(refund.id);
      expect(after.status).toBe('BLOCKED');
      expect(after.blockReason).toBe('NEEDS_CUSTOMER_DETAILS');
    });

    it('waits rather than escalating while the sibling deposit has not resolved yet', async () => {
      const { request } = await seedRequest();
      // No SUCCEEDED deposit at all yet.
      const refund = await submittedPayment('REFUND', request.id);

      await check.run(future());

      expect(paystack.listRefunds).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('escalates rather than waiting forever if the sibling deposit never resolves', async () => {
      // Should not be reachable in practice — refundDeposit's own claim
      // requires the deposit to already be SUCCEEDED — but an invisible
      // infinite loop here is exactly the stranded state this check exists
      // to remove, so it must not be exempt from the same escalation rule.
      const { request } = await seedRequest();
      const refund = await submittedPayment('REFUND', request.id, {
        verifyAttempts: MAX_VERIFY_ATTEMPTS,
      });

      await check.run(future());

      expect(paystack.listRefunds).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('no succeeded deposit'),
        expect.anything(),
      );
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('escalates when the succeeded deposit has no providerRef to build the query from', async () => {
      const { request } = await seedRequest();
      const deposit = await ledger.create({
        rescueRequestId: request.id,
        type: 'DEPOSIT',
        amount: 500_000,
      });
      await ledger.claimForSubmission(deposit.id, new Date());
      await ledger.claimTerminal(deposit.id, { status: 'SUCCEEDED' }); // no providerRef
      const refund = await submittedPayment('REFUND', request.id);

      await check.run(future());

      expect(paystack.listRefunds).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('providerRef'),
        expect.anything(),
      );
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });

    it('escalates once MAX_VERIFY_ATTEMPTS is reached with still no match', async () => {
      const { request } = await seedRequest();
      const deposit = await ledger.create({
        rescueRequestId: request.id,
        type: 'DEPOSIT',
        amount: 500_000,
      });
      await ledger.claimForSubmission(deposit.id, new Date());
      await ledger.claimTerminal(
        deposit.id,
        { status: 'SUCCEEDED' },
        { providerRef: 'txn:1' },
      );
      const refund = await submittedPayment('REFUND', request.id, {
        verifyAttempts: MAX_VERIFY_ATTEMPTS,
      });
      paystack.listRefunds.mockResolvedValue({ outcome: 'ok', data: [] });

      await check.run(future());

      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('max verify attempts'),
        expect.anything(),
      );
      expect((await reload(refund.id)).status).toBe('SUBMITTED');
    });
  });

  // ── Cross-cutting ────────────────────────────────────────────────────────

  describe('cross-cutting', () => {
    it('excludes BLOCKED rows entirely — nothing this check can do moves them', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('PAYOUT', request.id);
      await ledger.recordBlocked(payment.id, 'AWAITING_OTP');
      await prisma.payment.update({
        where: { id: payment.id },
        data: { verifyAfter: past() },
      });

      const acted = await check.run(future());

      expect(acted).toBe(0);
      expect(paystack.verifyTransfer).not.toHaveBeenCalled();
      expect((await reload(payment.id)).status).toBe('BLOCKED');
    });

    it('leaves rows whose verifyAfter is still in the future untouched', async () => {
      const { request } = await seedRequest();
      await pendingPayment('DEPOSIT', request.id);

      const acted = await check.run(past());

      expect(acted).toBe(0);
      expect(paystack.initializePayment).not.toHaveBeenCalled();
    });

    it('a webhook and this check racing the same payment produce one transition', async () => {
      const { request } = await seedRequest();
      const payment = await submittedPayment('DEPOSIT', request.id, {
        checkoutUrl: 'https://paystack.test/pay/x',
      });
      paystack.verifyTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'success', id: 1, amount: 500_000 },
      });

      // A webhook claiming the row concurrently with this check's own pass.
      const [, webhookWon] = await Promise.all([
        check.run(future()),
        ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' }),
      ]);

      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      // Exactly one of the two actually wrote the terminal state — the
      // other found nothing left to claim.
      const checkAppliedFee = after.providerRef === 'txn:1';
      expect(checkAppliedFee).toBe(!webhookWon);
    });

    it('processes multiple due rows of different types in one pass', async () => {
      const { request: r1 } = await seedRequest();
      const { request: r2 } = await seedRequest();
      await pendingPayment('DEPOSIT', r1.id);
      await pendingPayment('BALANCE', r2.id);
      paystack.initializePayment.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'timeout',
      });

      const acted = await check.run(future());

      expect(acted).toBe(2);
    });
  });
});
