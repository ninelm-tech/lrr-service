import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { WhatsAppCustomerFlowService } from '../../src/rescue-request/whatsapp-customer-flow.service';
import { PaymentEventsService } from '../../src/rescue-request/payment-events.service';
import { RescueRequestSharedService } from '../../src/rescue-request/rescue-request-shared.service';
import { WhatsAppSessionStore } from '../../src/rescue-request/state/whatsapp-session.store';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import {
  truncateAll,
  createCustomer,
  createOperator,
  createRequest,
  createOffer,
} from './factories';

/**
 * The per-operator deposit percentage, end to end against a real database.
 *
 * The unit specs already cover the branch logic in isolation (Task 3's
 * snapshot write, Task 5's snapshot read and 0%/rounding branches, Task 4's
 * activation extraction). What only a real database can show is that those
 * pieces compose correctly across two separate calls into the real service
 * methods: the snapshot taken at shortlist-delivery time really does survive
 * a later, real write to the operator's live override, and the full
 * 0%-deposit path really does leave the database in the state the other
 * callers of PaymentEventsService.activateAssignedJob depend on.
 *
 * Both tests drive the same two real entry points dispatch actually uses:
 * DispatchService.deliverQuoteShortlist (Task 3) and
 * WhatsAppCustomerFlowService.handleCustomerMessage, which — with the
 * session parked in WAITING_FOR_QUOTE_SELECTION, exactly as
 * deliverQuoteShortlist itself leaves it — routes into the private
 * handleQuoteSelected (Task 5/6's read site). This is the same public entry
 * point WhatsAppInboundService calls for every real inbound WhatsApp
 * message (see whatsapp-inbound.service.ts), so no private method is
 * invoked directly. The QUOTED DispatchOffer itself is seeded directly via
 * Prisma rather than simulated through a full dispatch round — that part of
 * the flow is dispatch.service's own integration coverage, not this one's.
 */
describe('Per-operator deposit percentage (integration)', () => {
  let prisma: PrismaService;
  let dispatchService: DispatchService;
  let customerFlowService: WhatsAppCustomerFlowService;
  let sharedService: RescueRequestSharedService;
  let sessionStore: WhatsAppSessionStore;
  let paystack: { initializePayment: jest.Mock };

  const ok = (url = 'https://paystack.test/pay/xyz') => ({
    outcome: 'ok' as const,
    data: { authorization_url: url, access_code: 'acc_1', reference: 'ref' },
  });

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);

    const twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
    };
    const geocoding = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    paystack = { initializePayment: jest.fn() };
    const paystackCustomer = {
      customerFor: jest
        .fn()
        .mockResolvedValue({ code: 'cus_test', email: 'customer@lrr.ng' }),
    };
    const platformConfig = {
      getConfig: jest
        .fn()
        .mockResolvedValue({ serviceFeePercent: 10, depositPercent: 20 }),
    };
    // Bracket-accessed as a "private" method on the real OperatorService in
    // both call sites under test (dispatch.service.ts and
    // whatsapp-customer-flow.service.ts) — stubbed the same way their own
    // unit specs do, since the real distance math isn't what either test
    // here is about.
    const operatorService = { calculateDistance: jest.fn().mockReturnValue(1) };

    sessionStore = new WhatsAppSessionStore(prisma);
    sharedService = new RescueRequestSharedService(
      prisma,
      geocoding as never,
      twilio as never,
      sessionStore,
    );
    const paymentLedger = new PaymentLedgerService(prisma);

    dispatchService = new DispatchService(
      prisma,
      twilio as never,
      operatorService as never,
      platformConfig as never,
      sessionStore,
      sharedService,
      {} as never, // OperatorMembershipService — not exercised by deliverQuoteShortlist
    );

    const paymentEventsService = new PaymentEventsService(
      prisma,
      paystack as never,
      twilio as never,
      {} as never, // PayoutService — only finalizeJobSettlement needs it, not exercised here
      sessionStore,
      sharedService,
      {} as never, // WhatsAppCustomerFlowService (forwardRef cycle) — unused inside activateAssignedJob
      paymentLedger,
      paystackCustomer as never,
    );

    customerFlowService = new WhatsAppCustomerFlowService(
      prisma,
      twilio as never,
      {} as never, // S3Service — no media handling on this path
      geocoding as never,
      {} as never, // RatingService — no rating flow on this path
      paystack as never,
      platformConfig as never,
      operatorService as never,
      dispatchService,
      {} as never, // DisputeService — no dispute flow on this path
      paymentEventsService,
      sessionStore,
      sharedService,
      paymentLedger,
      paystackCustomer as never,
    );
  });

  /**
   * Seeds the session the way a real customer's would already look by the
   * time quotes come back: rescueRequestId set when the request was
   * created, long before deliverQuoteShortlist moves state to
   * WAITING_FOR_QUOTE_SELECTION.
   */
  async function seedCustomerSession(
    customerId: string,
    rescueRequestId: string,
  ) {
    await sessionStore.getOrCreate(customerId);
    await sessionStore.update(customerId, { rescueRequestId });
  }

  function selectFirstQuote(
    phoneNumber: string,
    userId: string,
    session: unknown,
  ) {
    return customerFlowService.handleCustomerMessage(
      phoneNumber,
      userId,
      '1',
      '1',
      undefined,
      undefined,
      undefined,
      session as never,
      {},
    );
  }

  it('charges the deposit amount the customer actually saw, from an operator with a custom override', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, {
      depositPercentOverride: 25,
    });
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 100_000,
    });

    await seedCustomerSession(customer.id, request.id);

    // 1 & 2. Deliver the shortlist — this freezes the operator's
    // then-current 25% override onto the offer's depositPercentSnapshot.
    await dispatchService.deliverQuoteShortlist(request.id, customer.id);

    const quotedOffer = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(Number(quotedOffer.depositPercentSnapshot)).toBe(25);

    // 3. The operator's override changes mid-selection-window, as it would
    // if staff edited it between the shortlist being sent and the customer
    // actually replying.
    await prisma.operator.update({
      where: { id: operator.id },
      data: { depositPercentOverride: 50 },
    });

    // 4. Drive the same quote-selection logic handleQuoteSelected uses, via
    // its real public entry point (WhatsAppInboundService's own call site
    // for every inbound WhatsApp message) — not the private method directly.
    paystack.initializePayment.mockResolvedValue(ok());
    const session = await sessionStore.getOrCreate(customer.id);
    await selectFirstQuote(customer.phoneNumber!, customer.id, session);

    const updatedRequest = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    // total = 100,000 (quoted) + 10% service fee (10,000) = 110,000.
    // 25% of that = 27,500 — the frozen snapshot. The operator's live 50%
    // (which would charge 55,000) must NOT win, and neither should the 20%
    // platform default from this block's own config mock.
    expect(updatedRequest.depositAmount).toBe(27_500);
  });

  it('drives a 0%-deposit operator straight to OPERATOR_ASSIGNED with the offer ACCEPTED and zero DEPOSIT payments', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, {
      depositPercentOverride: 0,
    });
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'QUOTED',
      quotedPrice: 100_000,
    });

    await seedCustomerSession(customer.id, request.id);

    // activateAssignedJob (Task 4) resolves the operator's own WhatsApp
    // user by phone number and updates their existing session — which, in
    // the real flow, already exists because an operator must have messaged
    // in (to submit the quote that put this offer in QUOTED status) before
    // any of this runs. Seed that same precondition here, since this test
    // seeds the QUOTED offer directly rather than through a full dispatch
    // round.
    const operatorUser = await sharedService.findOrCreateCustomer(
      operator.phoneNumber!,
    );
    await sessionStore.getOrCreate(operatorUser.id);

    await dispatchService.deliverQuoteShortlist(request.id, customer.id);

    const quotedOffer = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(Number(quotedOffer.depositPercentSnapshot)).toBe(0);

    const session = await sessionStore.getOrCreate(customer.id);
    await selectFirstQuote(customer.phoneNumber!, customer.id, session);

    const updatedRequest = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(updatedRequest.status).toBe('OPERATOR_ASSIGNED');
    expect(updatedRequest.depositAmount).toBe(0);
    // total = 100,000 + 10% service fee (10,000) = 110,000, all of it balance.
    expect(updatedRequest.balanceAmount).toBe(110_000);

    const winningOffer = await prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(winningOffer.status).toBe('ACCEPTED');

    const depositPaymentCount = await prisma.payment.count({
      where: { rescueRequestId: request.id, type: 'DEPOSIT' },
    });
    expect(depositPaymentCount).toBe(0);
  });
});
