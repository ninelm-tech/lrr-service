import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { WhatsAppOperatorFlowService } from '../../src/rescue-request/whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from '../../src/rescue-request/whatsapp-customer-flow.service';
import { WhatsAppInboundService } from '../../src/rescue-request/whatsapp-inbound.service';
import { PaymentEventsService } from '../../src/rescue-request/payment-events.service';
import { RescueRequestSharedService } from '../../src/rescue-request/rescue-request-shared.service';
import { WhatsAppSessionStore } from '../../src/rescue-request/state/whatsapp-session.store';
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { OperatorService } from '../../src/operator/operator.service';
import { OperatorMembershipService } from '../../src/operator/operator-membership.service';
import { StuckOperatorJobCheck } from '../../src/rescue-request/reconciler/checks/stuck-operator-job.check';
import { truncateAll, createCustomer, createOperator } from './factories';

/**
 * End to end against a real database: an already-registered operator is
 * recognized by BSUID once their WhatsApp account goes masked (Tasks 4-7),
 * a masked operator never captured falls through to the customer flow
 * rather than being blocked (Task 7's corrected routing), a job that goes
 * stale under a masked operator is caught by the reconciler (Task 8), and
 * staff can then move it forward with a reasoned manual override that
 * resets the operator's session (Task 9).
 */
describe('WhatsApp BSUID operator recognition (integration)', () => {
  let prisma: PrismaService;
  let inboundService: WhatsAppInboundService;
  let adminService: RescueRequestAdminService;
  let sessionStore: WhatsAppSessionStore;
  let operatorMembershipService: OperatorMembershipService;
  let stuckOperatorJobCheck: StuckOperatorJobCheck;
  let twilio: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
  };

  const originalArrivedReminderSid =
    process.env.TWILIO_ARRIVED_REMINDER_TEMPLATE_SID;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(() => {
    if (originalArrivedReminderSid === undefined) {
      delete process.env.TWILIO_ARRIVED_REMINDER_TEMPLATE_SID;
    } else {
      process.env.TWILIO_ARRIVED_REMINDER_TEMPLATE_SID =
        originalArrivedReminderSid;
    }
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The ARRIVED-reminder's BSUID-aware destination fix (Task 6) only
    // runs on the Content Template branch — a template SID must be
    // configured for that code path to be reachable at all.
    process.env.TWILIO_ARRIVED_REMINDER_TEMPLATE_SID = 'HXarrivedreminder';

    twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
    };
    const paystack = { initializePayment: jest.fn() };
    const paystackCustomer = { customerFor: jest.fn() };
    const platformConfig = {
      getConfig: jest.fn().mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
        testCustomerPhoneNumbers: [],
        disputeAlertPhoneNumbers: ['+2348099999999'],
      }),
    };
    const geocoding = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    const payoutService = { createAndProcessPayout: jest.fn() };

    sessionStore = new WhatsAppSessionStore(prisma);
    operatorMembershipService = new OperatorMembershipService(prisma);
    const sharedService = new RescueRequestSharedService(
      prisma,
      geocoding as never,
      twilio as never,
      sessionStore,
    );
    const paymentLedger = new PaymentLedgerService(prisma);
    const operatorService = new OperatorService(
      prisma,
      {} as never,
      {} as never,
      operatorMembershipService,
      {} as never,
      platformConfig as never,
    );

    const dispatchService = new DispatchService(
      prisma,
      twilio as never,
      operatorService,
      platformConfig as never,
      sessionStore,
      sharedService,
      operatorMembershipService,
    );

    const paymentEventsService = new PaymentEventsService(
      prisma,
      paystack as never,
      twilio as never,
      payoutService as never,
      sessionStore,
      sharedService,
      {} as never,
      paymentLedger,
      paystackCustomer as never,
    );

    const customerFlowService = new WhatsAppCustomerFlowService(
      prisma,
      twilio as never,
      {} as never,
      geocoding as never,
      {} as never,
      paystack as never,
      platformConfig as never,
      operatorService,
      dispatchService,
      {} as never,
      paymentEventsService,
      sessionStore,
      sharedService,
      paymentLedger,
      paystackCustomer as never,
    );

    const operatorFlowService = new WhatsAppOperatorFlowService(
      prisma,
      twilio as never,
      dispatchService,
      paymentEventsService,
      customerFlowService,
      sessionStore,
      platformConfig as never,
    );

    inboundService = new WhatsAppInboundService(
      prisma,
      sessionStore,
      operatorFlowService,
      customerFlowService,
      sharedService,
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
      operatorMembershipService,
      payoutService as never,
      operatorService,
    );

    stuckOperatorJobCheck = new StuckOperatorJobCheck(
      prisma,
      twilio as never,
      platformConfig as never,
    );
  });

  it("recognizes a registered operator's masked ARRIVED reply by their passively-captured BSUID, and addresses the ARRIVED reminder to that same BSUID while masked", async () => {
    const operatorPhone = '+2348011112222';
    const operator = await createOperator(prisma, operatorPhone, {
      whatsappEnabled: true,
    });
    // No OperatorMember involved — recognition is now purely "does this
    // User's own on-file phoneNumber match a registered Operator," so the
    // User row below is created exactly as findOrCreateBySender would
    // create it on this operator's very first WhatsApp message, with no
    // staff/login relationship at all.
    const operatorUser = await prisma.user.create({
      data: { phoneNumber: operatorPhone, role: 'CUSTOMER' },
    });

    const customer = await createCustomer(prisma);
    const request = await prisma.rescueRequest.create({
      data: {
        customerId: customer.id,
        status: 'OPERATOR_ASSIGNED',
        latitude: 6.5,
        longitude: 3.4,
        vehicleType: 'SEDAN',
        assignedOperatorId: operator.id,
      },
    });
    await sessionStore.getOrCreate(operatorUser.id);
    await sessionStore.update(operatorUser.id, {
      state: 'OPERATOR_ON_JOB' as never,
      rescueRequestId: request.id,
    });

    // 1. First message is unmasked but — like every real WhatsApp webhook —
    // still carries ExternalUserId, which passively captures the BSUID.
    await inboundService.handleIncomingWhatsAppMessage({
      From: `whatsapp:${operatorPhone}`,
      Body: 'on my way',
      ExternalUserId: 'whatsapp:CA.op1',
    });

    const capturedUser = await prisma.user.findUnique({
      where: { id: operatorUser.id },
    });
    expect(capturedUser?.whatsappExternalUserId).toBe('CA.op1');

    // 2. Later, their account is masked: an unrecognized message while
    // ON_JOB gets the ARRIVED reminder — Task 6's fix means it's addressed
    // to the BSUID, not the (currently unreachable-as-masked) phone number.
    await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.op1',
      Body: 'huh',
    });

    expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
      'whatsapp:CA.op1',
      'HXarrivedreminder',
      expect.any(Object),
    );

    // 3. A masked ARRIVED reply — From is the BSUID, no phone at all —
    // still routes to the operator flow and updates the correct job.
    await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.op1',
      Body: 'ARRIVED',
    });

    const afterArrived = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(afterArrived?.status).toBe('ARRIVED');
  });

  it('falls through an unmatched masked operator to the customer flow, catches their stale job via the reconciler, and lets staff move it forward with a reasoned override that resets their session', async () => {
    const operatorPhone = '+2348033334444';
    const operator = await createOperator(prisma, operatorPhone, {
      whatsappEnabled: true,
    });
    // This operator's own WhatsApp session (tracked by their on-file phone)
    // is pre-seeded below to simulate "already mid-job," but their BSUID
    // has never been captured — no unmasked message was ever sent on this
    // account, unlike the previous test, so the router has nothing to
    // match the masked sender below against.
    const operatorUser = await prisma.user.create({
      data: { phoneNumber: operatorPhone, role: 'CUSTOMER' },
    });

    const customer = await createCustomer(prisma);
    const thirtyFiveMinutesAgo = new Date(Date.now() - 35 * 60 * 1000);
    const request = await prisma.rescueRequest.create({
      data: {
        customerId: customer.id,
        status: 'OPERATOR_ASSIGNED',
        latitude: 6.5,
        longitude: 3.4,
        vehicleType: 'SEDAN',
        assignedOperatorId: operator.id,
        updatedAt: thirtyFiveMinutesAgo,
      },
    });
    await sessionStore.getOrCreate(operatorUser.id);
    await sessionStore.update(operatorUser.id, {
      state: 'OPERATOR_ON_JOB' as never,
      rescueRequestId: request.id,
    });

    // 4. A masked message with a BSUID never seen before — indistinguishable
    // from a brand-new customer at this point — falls through to the
    // customer flow rather than being blocked (Task 7's corrected routing).
    await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.nevercaptured',
      Body: 'hello',
    });

    const newCustomerUser = await prisma.user.findUnique({
      where: { whatsappExternalUserId: 'CA.nevercaptured' },
    });
    expect(newCustomerUser).not.toBeNull();
    expect(newCustomerUser?.phoneNumber).toBeNull();
    // The operator's own job is untouched — the fallthrough never acted on it.
    const requestAfterFallthrough = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(requestAfterFallthrough?.status).toBe('OPERATOR_ASSIGNED');

    // 5. The job has now sat still for 35 minutes with a WhatsApp-enabled
    // operator assigned — the reconciler check (Task 8) catches it and
    // alerts staff with a concrete job reference.
    const acted = await stuckOperatorJobCheck.run(new Date());
    expect(acted).toBe(1);
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(request.id.slice(-6).toUpperCase()),
    );

    // 6. Staff use the reasoned manual-override action (Task 9) for this
    // same WhatsApp-enabled operator's job, which resets their session to
    // the same state a real, unmasked ARRIVED would have left it in.
    const { claimed } = await adminService.claimManualArrived(request.id, {
      reason: 'WhatsApp unreachable, operator called support',
    });
    expect(claimed).toBe(true);

    const resetSession = await prisma.whatsAppSession.findUnique({
      where: { userId: operatorUser.id },
    });
    expect(resetSession?.state).toBe('OPERATOR_AT_LOCATION');

    const afterOverride = await prisma.rescueRequest.findUnique({
      where: { id: request.id },
    });
    expect(afterOverride?.status).toBe('ARRIVED');
  });
});
