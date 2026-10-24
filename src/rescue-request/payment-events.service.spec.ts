import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { Payment } from '@prisma/client';
import { PaymentEventsService } from './payment-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import { createPaymentLedgerMock } from '../payment/testing/payment-ledger.mock';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { createPaystackCustomerServiceMock } from '../payment/testing/paystack-customer.mock';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';

/** The two fields confirmDeposit/confirmBalance actually read off Payment. */
const paymentFor = (rescueRequestId: string, id = 'pay-1'): Payment =>
  ({ id, rescueRequestId }) as Payment;

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  logger: { info: jest.fn() },
}));

describe('PaymentEventsService', () => {
  let service: PaymentEventsService;
  let prisma: {
    rescueRequest: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    dispatchOffer: { updateMany: jest.Mock };
    payment: { update: jest.Mock };
  };
  let payoutServiceMock: { createAndProcessPayout: jest.Mock };
  let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
  let twilioService: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
  };
  let sharedService: {
    findOrCreateCustomer: jest.Mock;
    formatLocationSection: jest.Mock;
    endRelayForEndedRequest: jest.Mock;
  };
  let dispatchService: { startDispatch: jest.Mock };
  let customerFlowService: { scheduleRatingTimeout: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rescueRequest: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'req-1',
          customerId: 'cust-1',
          status: 'WAITING_FOR_DEPOSIT',
          balanceAmount: 200000,
          depositAmount: 50000,
          serviceFeeAmount: 25000,
          assignedOperatorId: 'op-1',
          customer: { phoneNumber: '+2348012345678' },
          assignedOperator: {
            id: 'op-1',
            businessName: 'Swift Towing',
            phoneNumber: '+2349012345678',
            whatsappEnabled: true,
          },
        }),
      },
      dispatchOffer: { updateMany: jest.fn() },
      payment: { update: jest.fn() },
    };
    payoutServiceMock = { createAndProcessPayout: jest.fn() };
    sessionStore = {
      update: jest.fn(),
      getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }),
    };
    twilioService = {
      sendWhatsAppMessage: jest.fn(),
      sendWhatsAppTemplateMessage: jest.fn(),
    };
    sharedService = {
      findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
      formatLocationSection: jest
        .fn()
        .mockResolvedValue('https://maps.google.com/?q=6.5,3.4'),
      endRelayForEndedRequest: jest.fn(),
    };
    dispatchService = { startDispatch: jest.fn() };
    customerFlowService = { scheduleRatingTimeout: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentEventsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PaymentLedgerService,
          useValue: createPaymentLedgerMock(),
        },
        {
          provide: PaystackCustomerService,
          useValue: createPaystackCustomerServiceMock(),
        },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: twilioService },
        { provide: PayoutService, useValue: payoutServiceMock },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestSharedService, useValue: sharedService },
        { provide: DispatchService, useValue: dispatchService },
        { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
      ],
    }).compile();

    service = module.get<PaymentEventsService>(PaymentEventsService);
  });

  describe('confirmDeposit', () => {
    // Redelivery/race idempotency is no longer this method's job — the
    // caller's own claim on the Payment row (claimTerminal's CAS) is what
    // guarantees confirmDeposit is reached at most once per settlement, and
    // that CAS is already covered in payment-ledger.int-spec.ts. This
    // method now trusts its caller and always proceeds when called.

    const originalArrivedSid = process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID;
    beforeEach(() => {
      delete process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID;
    });
    afterEach(() => {
      if (originalArrivedSid === undefined)
        delete process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID;
      else process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID = originalArrivedSid;
    });

    it('sends the operator the freeform "send ARRIVED" prompt when no template SID is configured', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('2342'),
        expect.stringContaining('send *ARRIVED*'),
      );
      expect(twilioService.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends the operator a real ARRIVED button via the Content Template when the SID is configured', async () => {
      process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID = 'HXarrived123';
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('2342'),
        'HXarrived123',
        expect.any(Object),
      );
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('2342'),
        expect.anything(),
      );
    });

    it('sends the arrived template with single-line variables even when the location has an address and a line break', async () => {
      // WhatsApp rejects newlines/tabs/4+ spaces in template parameters
      // (Twilio 21656) — the real formatLocationSection output is
      // "<address>\n📍 <link>".
      process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID = 'HXarrived123';
      sharedService.formatLocationSection.mockResolvedValue(
        '12 Allen Ave, Ikeja\n📍 https://maps.google.com/?q=6.5,3.4',
      );
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: null },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      const variables = twilioService.sendWhatsAppTemplateMessage.mock
        .calls[0][2] as Record<string, string>;
      expect(Object.keys(variables)).toEqual(['1', '2', '3', '4']);
      for (const value of Object.values(variables)) {
        expect(value).not.toMatch(/[\r\n\t]| {4}/);
        expect(value.trim()).not.toBe('');
      }
      expect(variables['4']).toBe(
        '12 Allen Ave, Ikeja · 📍 https://maps.google.com/?q=6.5,3.4',
      );
    });

    describe('when the arrived template send fails', () => {
      const requestWithOperator = {
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      };

      beforeEach(() => {
        process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID = 'HXarrived123';
        prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue(
          requestWithOperator,
        );
        twilioService.sendWhatsAppTemplateMessage.mockRejectedValue(
          new Error('The Content Variables parameter is invalid.'),
        );
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
      });
      afterEach(() => jest.restoreAllMocks());

      it('falls back to the freeform "send ARRIVED" text so the operator still hears about the job', async () => {
        await expect(
          service.confirmDeposit(paymentFor('req-1')),
        ).resolves.toBeUndefined();

        expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
          expect.stringContaining('2342'),
          expect.stringContaining('send *ARRIVED*'),
        );
      });

      it('does not fail the payment webhook, and reports to Sentry, when the fallback fails too', async () => {
        twilioService.sendWhatsAppMessage.mockImplementation((to: string) =>
          to.includes('2342')
            ? Promise.reject(new Error('session window closed'))
            : Promise.resolve(undefined),
        );

        await expect(
          service.confirmDeposit(paymentFor('req-1')),
        ).resolves.toBeUndefined();

        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            extra: expect.objectContaining({
              stage: 'activate-assigned-job-operator-message',
            }),
          }),
        );
      });
    });

    it('assigns the operator and confirms for a WAITING_FOR_DEPOSIT request', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'OPERATOR_ASSIGNED' },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining('operator is on the way'),
      );
    });

    it('still activates the job (offer flip, both session transitions) even when sending the customer confirmation rejects', async () => {
      // The reverse of the failure-isolation this method already has: a
      // Twilio failure sending the customer's OWN message must not swallow
      // activateAssignedJob below it — that's the real operational work
      // (offer flip, both session transitions, operator's job-is-live
      // message), and it must run regardless of whether this one customer
      // message got through. The failure itself must be caught and logged,
      // not rethrown.
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to === '+2341') return Promise.reject(new Error('Twilio down'));
        return Promise.resolve();
      });

      await expect(
        service.confirmDeposit(paymentFor('req-1')),
      ).resolves.toBeUndefined();

      // activateAssignedJob's own work must have run — e.g. the operator's
      // session move to OPERATOR_ON_JOB, which only happens inside it.
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        state: 'OPERATOR_ON_JOB',
        rescueRequestId: 'req-1',
      });
    });

    it('moves the customer session to REQUEST_CONFIRMED as part of the normal paid-deposit activation', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.confirmDeposit(paymentFor('req-1'));

      // This is a new assertion, not a pre-existing one — confirmDeposit's
      // existing tests in this block never checked the session transition
      // directly, only the messages it sends. It exists as a named anchor
      // for the activateAssignedJob extraction below: if this still passes
      // once confirmDeposit delegates to it, the extraction preserved the
      // real behavior.
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: 'REQUEST_CONFIRMED',
      });
    });

    it('cancels a paid deposit with no preassigned operator instead of dispatching after payment', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: null,
        status: 'WAITING_FOR_DEPOSIT',
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'CANCELLED', needsManualAssignment: false },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: 'IDLE',
        rescueRequestId: undefined,
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rescueRequestId: 'req-1',
          status: { in: ['PENDING', 'SELECTED_PENDING_PAYMENT'] },
        },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'QUOTED' },
        data: { status: 'NOT_SELECTED', respondedAt: expect.any(Date) },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining('flagged it for refund'),
      );
      expect(dispatchService.startDispatch).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Deposit confirmed without an assigned operator',
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('routes to handleLateDeposit for a CANCELLED request, and writes nothing — eligibility is derived', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2341',
        expect.stringContaining("We're processing a refund"),
      );
      expect(dispatchService.startDispatch).not.toHaveBeenCalled();
    });

    it('alerts Sentry and does nothing automatic for an unexpected non-CANCELLED status', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'ARRIVED', // some other status, neither WAITING_FOR_DEPOSIT nor CANCELLED
        customer: { phoneNumber: '+2341' },
        assignedOperator: null,
      });

      await service.confirmDeposit(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Deposit confirmed in unexpected (non-CANCELLED) status',
        expect.objectContaining({ level: 'error' }),
      );
    });
  });

  describe('activateAssignedJob', () => {
    it('still surfaces a failed operator message to its own caller (the 0%-deposit paths), unlike the payment webhook', async () => {
      // Only confirmDeposit opts in to swallowing — see its
      // swallowOperatorNotifyErrors flag — because a 500 there makes Paystack
      // redeliver into a non-idempotent confirmDeposit. The 0%-deposit
      // callers have no such retry and must still find out.
      delete process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID;
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });
      twilioService.sendWhatsAppMessage.mockRejectedValue(
        new Error('session window closed'),
      );

      await expect(service.activateAssignedJob('req-1')).rejects.toThrow(
        'session window closed',
      );
    });

    it('flips a SELECTED_PENDING_PAYMENT offer to ACCEPTED', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'SELECTED_PENDING_PAYMENT',
        },
        data: { status: 'ACCEPTED' },
      });
    });

    it('moves the customer session to REQUEST_CONFIRMED and the operator session to OPERATOR_ON_JOB', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: 'REQUEST_CONFIRMED',
      });
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        state: 'OPERATOR_ON_JOB',
        rescueRequestId: 'req-1',
      });
    });

    it("ensures the operator's session row exists before updating it — a freshly adminCreate'd operator with no inbound WhatsApp history has no row yet, and update() alone throws P2025 for that case", async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(sessionStore.getOrCreate).toHaveBeenCalledWith('op-user-1');
      // getOrCreate (an idempotent upsert) must run BEFORE the plain
      // update() call for that same user — that ordering is the fix: it
      // guarantees a row exists by the time update() runs, instead of
      // update() throwing P2025 against an operator who has never sent an
      // inbound WhatsApp message.
      const getOrCreateOrder =
        sessionStore.getOrCreate.mock.invocationCallOrder[0];
      const operatorUpdateCallIndex = sessionStore.update.mock.calls.findIndex(
        (call: unknown[]) => call[0] === 'op-user-1',
      );
      const operatorUpdateOrder =
        sessionStore.update.mock.invocationCallOrder[operatorUpdateCallIndex];
      expect(getOrCreateOrder).toBeLessThan(operatorUpdateOrder);
    });

    it('sends the operator their job-is-live details, honoring the ARRIVED template SID the same way confirmDeposit does', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: true,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('2342'),
        expect.stringContaining('send *ARRIVED*'),
      );
    });

    it('does nothing when the request has no assigned operator', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: null,
        assignedOperator: null,
        customer: { phoneNumber: '+2341' },
      });

      await service.activateAssignedJob('req-1');

      expect(sessionStore.update).not.toHaveBeenCalled();
      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
    });

    it('skips the operator WhatsApp notification and session setup when the operator has no WhatsApp on file', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: false,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('2342'),
        expect.anything(),
      );
      expect(twilioService.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalledWith(
        'op-user-1',
        expect.anything(),
      );
    });

    it('still flips the offer status and moves the customer session regardless of whatsappEnabled — those are not WhatsApp side effects', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        latitude: 6.5,
        longitude: 3.4,
        customer: { phoneNumber: '+2341' },
        assignedOperator: {
          businessName: 'Swift',
          phoneNumber: '+2342',
          whatsappEnabled: false,
        },
      });

      await service.activateAssignedJob('req-1');

      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: {
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'SELECTED_PENDING_PAYMENT',
        },
        data: { status: 'ACCEPTED' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: 'REQUEST_CONFIRMED',
      });
    });
  });

  describe('confirmBalance — payout trigger', () => {
    // As with confirmDeposit: redelivery/race idempotency is the caller's
    // claim on the Payment row, not this method's job any more.
    const BALANCE_REQUEST_FIXTURE = {
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 200000,
      depositAmount: 50000,
      serviceFeeAmount: 25000,
      assignedOperatorId: 'op-1',
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
        whatsappEnabled: true,
      },
    };

    beforeEach(() => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue(
        BALANCE_REQUEST_FIXTURE,
      );
    });

    it('completes the request unconditionally — the Payment CAS is what guarantees exactly once', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('triggers a payout for depositAmount + balanceAmount - serviceFeeAmount', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith(
        'req-1',
        'op-1',
        225000,
      );
    });

    it('skips the payout call when the computed payoutAmount is zero — same guard as the admin cancellation-settlement path', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        ...BALANCE_REQUEST_FIXTURE,
        depositAmount: 25000,
        balanceAmount: 0,
        serviceFeeAmount: 25000, // payoutAmount = 25000 + 0 - 25000 = 0
      });

      await service.confirmBalance(paymentFor('req-1'));

      expect(payoutServiceMock.createAndProcessPayout).not.toHaveBeenCalled();
    });

    it('skips the payout call when the computed payoutAmount is negative — a low deposit percentage plus a dispute adjustment can drive this below zero', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        ...BALANCE_REQUEST_FIXTURE,
        depositAmount: 10000,
        balanceAmount: 0,
        serviceFeeAmount: 25000, // payoutAmount = 10000 + 0 - 25000 = -15000
      });

      await service.confirmBalance(paymentFor('req-1'));

      expect(payoutServiceMock.createAndProcessPayout).not.toHaveBeenCalled();
    });

    it('invites a phone-only customer to create a portal account', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/register/customer'),
      );
    });

    it('releases any open chat relay — otherwise it swallows the rating replies prompted just below', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(sharedService.endRelayForEndedRequest).toHaveBeenCalledWith(
        'req-1',
      );
    });

    it('identifies the completed job and rated party in both rating prompts', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('Swift Towing on Job #REQ-1'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2349012345678',
        expect.stringContaining('the customer on Job #REQ-1'),
      );
    });

    it('tells a customer who already has portal credentials to log in instead', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        ...BALANCE_REQUEST_FIXTURE,
        customer: {
          phoneNumber: '+2348012345678',
          email: 'ada@example.com',
          passwordHash: 'hashed',
        },
      });

      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('/login'),
      );
    });

    it('is equivalent to finalizeJobSettlement for the ordinary non-zero-balance case', async () => {
      await service.confirmBalance(paymentFor('req-1'));

      // Every existing assertion in this describe block already proves
      // confirmBalance's observable behavior (status update, payout trigger,
      // customer/operator notifications, rating-prompt sessions, relay
      // release) — this test exists as a named anchor for the extraction
      // described in this task, not new behavior. If every other test in
      // this block still passes after confirmBalance becomes a one-line
      // wrapper around finalizeJobSettlement, this one needs no body beyond
      // confirming the call doesn't throw.
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('skips the operator WhatsApp notification and rating-session setup when the operator has no WhatsApp on file', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        ...BALANCE_REQUEST_FIXTURE,
        assignedOperator: {
          ...BALANCE_REQUEST_FIXTURE.assignedOperator,
          whatsappEnabled: false,
        },
      });

      await service.confirmBalance(paymentFor('req-1'));

      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
        'whatsapp:+2349012345678',
        expect.anything(),
      );
      // Customer-directed sends (status confirmation, rating prompt) must
      // still fire — only the operator side is guarded.
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.anything(),
      );
    });
  });

  describe('sendBalancePaymentLink — balanceAmount === 0 (100% deposit)', () => {
    const ZERO_BALANCE_TARGET = {
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 0,
      customer: { phoneNumber: '+2348012345678', email: null },
    };

    it('finalizes the job settlement instead of attempting a Paystack call', async () => {
      const paystackService = { initializePayment: jest.fn() };
      (
        service as unknown as { paystackService: typeof paystackService }
      ).paystackService = paystackService;
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        balanceAmount: 0,
        depositAmount: 500000,
        serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678' },
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
          whatsappEnabled: true,
        },
      });

      await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

      expect(paystackService.initializePayment).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('still triggers the payout — same formula as a real settled balance', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        balanceAmount: 0,
        depositAmount: 500000,
        serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678' },
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
          whatsappEnabled: true,
        },
      });

      await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

      expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith(
        'req-1',
        'op-1',
        475000, // depositAmount(500000) + balanceAmount(0) - serviceFeeAmount(25000)
      );
    });

    it('tells the customer the deposit covered everything, instead of a confusing "₦0" message', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        balanceAmount: 0,
        depositAmount: 500000,
        serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678' },
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
          whatsappEnabled: true,
        },
      });

      await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

      const customerMessages = twilioService.sendWhatsAppMessage.mock.calls
        .filter((call: unknown[]) => call[0] === '+2348012345678')
        .map((call: unknown[]) => call[1] as string);
      expect(customerMessages.some((body) => body.includes('₦0'))).toBe(false);
      expect(
        customerMessages.some((body) =>
          body.includes(
            '✅ Job complete! Your deposit covered the full amount — thank you for using Local Roadside Rescue 🙏',
          ),
        ),
      ).toBe(true);
    });

    it('tells the operator the deposit covered the full job amount, instead of a confusing "₦0 balance" message', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        balanceAmount: 0,
        depositAmount: 500000,
        serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678' },
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
          whatsappEnabled: true,
        },
      });

      await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

      const operatorMessages = twilioService.sendWhatsAppMessage.mock.calls
        .filter((call: unknown[]) => call[0] === 'whatsapp:+2349012345678')
        .map((call: unknown[]) => call[1] as string);
      expect(operatorMessages.some((body) => body.includes('₦0'))).toBe(false);
      expect(
        operatorMessages.some((body) =>
          body.includes(
            '💵 *Job complete!* — Job #REQ-1\n\nThe deposit covered the full job amount.',
          ),
        ),
      ).toBe(true);
    });

    it('does not fire the "missing balanceAmount" Sentry error for a legitimate zero', async () => {
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        balanceAmount: 0,
        depositAmount: 500000,
        serviceFeeAmount: 25000,
        assignedOperatorId: 'op-1',
        customer: { phoneNumber: '+2348012345678' },
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2349012345678',
          whatsappEnabled: true,
        },
      });

      await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

      expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('missing balanceAmount'),
        expect.anything(),
      );
    });

    it('still treats a genuinely missing (null) balanceAmount as the existing error case', async () => {
      await service.sendBalancePaymentLink({
        ...ZERO_BALANCE_TARGET,
        balanceAmount: null,
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('missing balanceAmount'),
        'error',
      );
    });
  });

  describe('markJobCompleted', () => {
    it('blocks a request that was ever disputed, resolved or not', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: true,
        disputeResolvedAt: new Date('2026-01-01'),
        payments: [],
        customer: { phoneNumber: '+2348012345678' },
      });

      await expect(service.markJobCompleted('req-1')).rejects.toThrow(
        'unresolved dispute',
      );
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('proceeds normally for a request that was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: false,
        disputeResolvedAt: null,
        // No succeeded BALANCE payment — derived depositPaid/balancePaid
        // replacement for the old balancePaid: false.
        payments: [],
        balanceAmount: 45000,
        customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      const paystackService = {
        initializePayment: jest.fn().mockResolvedValue({
          outcome: 'ok',
          data: {
            authorization_url: 'https://pay.example/1',
            access_code: 'acc_1',
            reference: 'BAL_pay-1',
          },
        }),
      };
      (service as any).paystackService = paystackService;

      await service.markJobCompleted('req-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });

    it('does not send a balance link when a succeeded BALANCE payment already exists', async () => {
      const paystackService = { initializePayment: jest.fn() };
      (service as any).paystackService = paystackService;
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        disputed: false,
        disputeResolvedAt: null,
        payments: [{ type: 'BALANCE', status: 'SUCCEEDED' }],
        balanceAmount: 45000,
        customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });

      await service.markJobCompleted('req-1');

      expect(paystackService.initializePayment).not.toHaveBeenCalled();
    });
  });
});
