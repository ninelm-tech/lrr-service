import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { WhatsAppOperatorFlowService } from '../../src/rescue-request/whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from '../../src/rescue-request/whatsapp-customer-flow.service';
import { PaymentEventsService } from '../../src/rescue-request/payment-events.service';
import { RescueRequestSharedService } from '../../src/rescue-request/rescue-request-shared.service';
import { WhatsAppSessionStore } from '../../src/rescue-request/state/whatsapp-session.store';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { OperatorService } from '../../src/operator/operator.service';
import { toWhatsAppAddress } from '../../src/common/phone.util';
import {
  truncateAll,
  createCustomer,
  createOperator,
  createRequest,
} from './factories';

/**
 * The full non-WhatsApp manual-dispatch journey, end to end against a real
 * database: exhaustion flags the request for staff, a staff-driven
 * assignment claims it, ARRIVED/DONE are driven through the manual
 * controller-equivalent service calls instead of an operator's own WhatsApp
 * replies, and the job still completes through the customer's ordinary
 * CONFIRM/balance-payment flow. The whole point of the feature is that the
 * operator never needs a WhatsApp channel for any of this — every assertion
 * below is checked against that constraint, not just the happy-path status
 * transitions.
 *
 * depositPercent is the platform-wide floor (10%, as of the 2026-10-24
 * hotfix that made 0% deposits impossible) — a real deposit payment is
 * simulated inline (confirmDeposit, same as the BALANCE payment later in
 * this same test) rather than skipped, since 0% is no longer a real
 * codepath to exercise.
 */
describe('Non-WhatsApp operator manual dispatch (integration)', () => {
  let prisma: PrismaService;
  let dispatchService: DispatchService;
  let adminService: RescueRequestAdminService;
  let operatorFlowService: WhatsAppOperatorFlowService;
  let customerFlowService: WhatsAppCustomerFlowService;
  let paymentEventsService: PaymentEventsService;
  let paymentLedger: PaymentLedgerService;
  let sessionStore: WhatsAppSessionStore;
  let twilio: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
  };
  let paystack: { initializePayment: jest.Mock };

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);

    twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
    };
    paystack = {
      initializePayment: jest.fn().mockResolvedValue({
        outcome: 'ok',
        data: {
          authorization_url: 'https://paystack.test/pay/xyz',
          access_code: 'acc_1',
          reference: 'ref',
        },
      }),
    };
    const paystackCustomer = {
      customerFor: jest
        .fn()
        .mockResolvedValue({ code: 'cus_test', email: 'customer@lrr.ng' }),
    };
    const platformConfig = {
      getConfig: jest.fn().mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
        testCustomerPhoneNumbers: [],
      }),
    };
    const geocoding = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    const payoutService = { createAndProcessPayout: jest.fn() };

    sessionStore = new WhatsAppSessionStore(prisma);
    const sharedService = new RescueRequestSharedService(
      prisma,
      geocoding as never,
      twilio as never,
      sessionStore,
    );
    paymentLedger = new PaymentLedgerService(prisma);
    const operatorService = new OperatorService(
      prisma,
      {} as never, // PaystackService — not exercised by findAndRankCandidates
      {} as never, // OtpService — registration only, unused here
      {} as never, // OperatorMembershipService — unused here
      {} as never, // AuditLogService — unused here
      platformConfig as never,
    );

    dispatchService = new DispatchService(
      prisma,
      twilio as never,
      operatorService,
      platformConfig as never,
      sessionStore,
      sharedService,
      {} as never, // OperatorMembershipService — unused by resolveExhaustion
    );

    paymentEventsService = new PaymentEventsService(
      prisma,
      paystack as never,
      twilio as never,
      payoutService as never,
      sessionStore,
      sharedService,
      {} as never, // WhatsAppCustomerFlowService (forwardRef cycle) — never called from inside this class
      paymentLedger,
      paystackCustomer as never,
    );

    customerFlowService = new WhatsAppCustomerFlowService(
      prisma,
      twilio as never,
      {} as never, // S3Service — no media handling on this path
      geocoding as never,
      {} as never, // RatingService — rating replies aren't exercised here
      paystack as never,
      platformConfig as never,
      operatorService,
      dispatchService,
      {} as never, // DisputeService — no dispute flow on this path
      paymentEventsService,
      sessionStore,
      sharedService,
      paymentLedger,
      paystackCustomer as never,
    );

    operatorFlowService = new WhatsAppOperatorFlowService(
      prisma,
      twilio as never,
      dispatchService,
      paymentEventsService,
      customerFlowService,
      sessionStore,
      platformConfig as never,
    );

    adminService = new RescueRequestAdminService(
      prisma,
      paystack as never,
      twilio as never,
      platformConfig as never,
      paymentEventsService,
      dispatchService,
      sharedService,
      sessionStore,
      paymentLedger,
      paystackCustomer as never,
      {} as never, // OperatorMembershipService — unused by assignOperator/claimManualArrived
      payoutService as never,
      operatorService,
    );
  });

  it('flags for manual assignment, gets assigned, dispatched, arrived, and completed — all without any WhatsApp send to the operator', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, {
      whatsappEnabled: false,
      // The default SEDAN vehicleType (createRequest's own default) is
      // only eligible for LIGHT_DUTY/TEN_TYRE truck classes — without this,
      // findAndRankCandidates' truckClasses filter excludes the operator
      // from every candidate search in this scenario.
      truckClasses: ['LIGHT_DUTY'],
    });
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      dispatchRound: 0,
    });
    const operatorAddress = toWhatsAppAddress(operator.phoneNumber!);
    // A real customer always has a session row by the time any of this runs
    // (WhatsAppInboundService calls getOrCreate on every inbound message,
    // starting with their own SOS) — seed it the same way, rather than
    // leaving session writes further down with no row to update.
    await sessionStore.getOrCreate(customer.id);
    await sessionStore.update(customer.id, { rescueRequestId: request.id });

    // 1. Simulate round-exhaustion directly — the round-by-round drive to
    // get here is dispatch.service's own integration coverage, not this
    // scenario's concern.
    const resolution = await prisma.$transaction((tx) =>
      dispatchService.resolveExhaustion(
        tx,
        {
          id: request.id,
          latitude: request.latitude,
          longitude: request.longitude,
          vehicleType: request.vehicleType,
          offeredOperatorIds: [],
          customerId: request.customerId,
        },
        { reason: 'rounds-exhausted', round: 3, extraRadiusKm: 4 },
        false,
      ),
    );
    expect(resolution.outcome).toBe('manual-fallback');

    // 2. needsManualAssignment flipped true.
    let current = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(current.needsManualAssignment).toBe(true);
    expect(current.status).toBe('DISPATCHING');

    // 3. assignOperator succeeds for a non-WhatsApp operator specifically
    // because needsManualAssignment is set; the flag clears; a real deposit
    // is now required (0% is no longer possible as of the 2026-10-24
    // hotfix), so this lands on WAITING_FOR_DEPOSIT first.
    await adminService.assignOperator(request.id, {
      operatorId: operator.id,
      priceKobo: 500_000,
    });
    current = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(current.needsManualAssignment).toBe(false);
    expect(current.status).toBe('WAITING_FOR_DEPOSIT');
    expect(current.assignedOperatorId).toBe(operator.id);

    // 3b. Simulate the deposit actually being paid — the real ledger claim
    // sequence a webhook drives (claimForSubmission, then claimTerminal to
    // SUCCEEDED; see payment-webhooks.int-spec.ts for the same pattern)
    // before calling confirmDeposit, not just confirmDeposit alone —
    // confirmDeposit itself never touches Payment.status, it only reacts to
    // an already-settled row, exactly as PaymentService.settle() hands it
    // one in production.
    const freshDeposit = await prisma.payment.findFirstOrThrow({
      where: { rescueRequestId: request.id, type: 'DEPOSIT' },
    });
    await paymentLedger.claimForSubmission(freshDeposit.id, new Date());
    await paymentLedger.claimTerminal(freshDeposit.id, {
      status: 'SUCCEEDED',
    });
    const depositPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: freshDeposit.id },
    });
    expect(depositPayment.status).toBe('SUCCEEDED');
    await paymentEventsService.confirmDeposit(depositPayment);
    current = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(current.status).toBe('OPERATOR_ASSIGNED');

    // 4. The "deposit paid, dispatch now" badge's own derived condition —
    // assignedOperator.whatsappEnabled === false && status ===
    // OPERATOR_ASSIGNED — reads true from a fresh row.
    expect(current.status).toBe('OPERATOR_ASSIGNED');
    expect(operator.whatsappEnabled).toBe(false);

    // 5. claimManualArrived — the atomic status write PATCH manual-arrived
    // itself calls before notifying — then notifyCustomerOperatorArrived
    // separately, exactly as the controller endpoint does, proving the two
    // halves compose correctly over a real claimed row.
    const arrivedClaim = await adminService.claimManualArrived(request.id);
    expect(arrivedClaim.claimed).toBe(true);
    current = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(current.status).toBe('ARRIVED');

    await operatorFlowService.notifyCustomerOperatorArrived(request.id);
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      customer.phoneNumber,
      expect.stringContaining('arrived'),
    );

    // 6. The manual-done equivalent — self-contained atomic claim, no
    // RequestMedia required at all.
    const doneClaim =
      await operatorFlowService.startManualCompletionConfirmation(request.id);
    expect(doneClaim.claimed).toBe(true);
    const mediaCount = await prisma.requestMedia.count({
      where: { rescueRequestId: request.id },
    });
    expect(mediaCount).toBe(0);
    const sessionAfterDone = await sessionStore.getOrCreate(customer.id);
    expect(sessionAfterDone.state).toBe('AWAITING_COMPLETION_CONFIRM');

    // 7. The customer's real CONFIRM command, through the same public entry
    // point WhatsAppInboundService routes every inbound customer message
    // through.
    await customerFlowService.handleCustomerMessage(
      customer.phoneNumber!,
      customer.id,
      'confirm',
      'CONFIRM',
      undefined,
      undefined,
      undefined,
      sessionAfterDone,
      {},
    );
    current = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(current.status).toBe('COMPLETED');
    const balancePayment = await prisma.payment.findFirstOrThrow({
      where: { rescueRequestId: request.id, type: 'BALANCE' },
    });
    expect(paystack.initializePayment).toHaveBeenCalled();

    // 8. The real webhook/verify entry point for a settled BALANCE payment.
    await paymentEventsService.confirmBalance(balancePayment);

    // 9. No outbound WhatsApp message was ever addressed to the operator —
    // the entire point of the feature — and RequestMedia stays empty
    // (deliberate exemption, not an oversight).
    const allRecipients = [
      ...twilio.sendWhatsAppMessage.mock.calls.map(
        (call: unknown[]) => call[0],
      ),
      ...twilio.sendWhatsAppTemplateMessage.mock.calls.map(
        (call: unknown[]) => call[0],
      ),
    ];
    expect(allRecipients).not.toContain(operatorAddress);
    expect(allRecipients).not.toContain(operator.phoneNumber);
    const finalMediaCount = await prisma.requestMedia.count({
      where: { rescueRequestId: request.id },
    });
    expect(finalMediaCount).toBe(0);
  });
});
