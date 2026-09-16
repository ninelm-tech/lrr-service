import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from '../payment/payment-ledger.service';
import {
  createPaymentLedgerMock,
  PaymentLedgerMock,
} from '../payment/testing/payment-ledger.mock';
import { PaystackCustomerService } from '../payment/paystack-customer.service';
import { createPaystackCustomerServiceMock } from '../payment/testing/paystack-customer.mock';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PaymentEventsService } from './payment-events.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { Prisma } from '@prisma/client';

describe('RescueRequestAdminService', () => {
  describe('detailForUser — quote-compliance data', () => {
    let detailService: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operatorMember: { findMany: jest.Mock };
    };
    let platformConfigService: { getConfig: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        operatorMember: { findMany: jest.fn() },
      };
      platformConfigService = { getConfig: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
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
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      detailService = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    const baseRaw = {
      id: 'req-1',
      status: 'DISPATCHING',
      issueType: undefined,
      vehicleType: 'SEDAN',
      destination: 'Mainland',
      latitude: null,
      longitude: null,
      depositAmount: undefined,
      balanceAmount: undefined,
      // depositPaid/balancePaid/depositReference/balanceReference are now
      // derived from this relation — see domain/derive-payment-state.ts.
      payments: [],
      createdAt: new Date('2026-08-10T00:00:00Z'),
      updatedAt: new Date('2026-08-10T00:00:00Z'),
      customer: {
        id: 'cust-1',
        phoneNumber: '+2340000000000',
        email: null,
        name: null,
      },
      assignedOperatorId: null,
      assignedOperator: null,
      media: [],
      dispatchOffers: [
        {
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 2500000,
          offeredAt: new Date('2026-08-10T00:00:00Z'),
          respondedAt: new Date('2026-08-10T00:05:00Z'),
          operator: { id: 'op-1', businessName: 'Swift Towing' },
        },
      ],
    };

    it('includes offers with computed motoristFacingTotal for ADMIN', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(baseRaw);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.destination).toBe('Mainland');
      expect(result.data.offers).toEqual([
        expect.objectContaining({
          operatorId: 'op-1',
          businessName: 'Swift Towing',
          quotedPrice: 2500000,
          motoristFacingTotal: 2750000,
        }),
      ]);
    });

    it('includes ratings with their flagged/resolved state for ADMIN', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        ratings: [
          {
            id: 'rating-1',
            direction: 'MOTORIST_TO_OPERATOR',
            score: 1,
            comment: null,
            flagged: true,
            flaggedAt: new Date('2026-01-01'),
            flaggedResolvedAt: null,
          },
        ],
      });
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.ratings).toEqual([
        expect.objectContaining({
          id: 'rating-1',
          score: 1,
          flagged: true,
          flaggedResolvedAt: undefined,
        }),
      ]);
    });

    it('omits offers entirely for OPERATOR', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        assignedOperatorId: 'op-1',
        assignedOperator: {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber: '+2341111111111',
          email: null,
        },
      });
      prisma.operatorMember.findMany.mockResolvedValue([
        { operatorId: 'op-1' },
      ]);

      const result = await detailService.detailForUser(
        { role: 'OPERATOR', userId: 'user-1' },
        'req-1',
      );

      expect(result.data.offers).toBeUndefined();
    });

    it('returns data for a CUSTOMER who owns the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      const result = await detailService.detailForUser(
        { role: 'CUSTOMER', userId: 'cust-1' },
        'req-1',
      );

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.offers).toBeUndefined();
    });

    it('rejects a CUSTOMER who does not own the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      await expect(
        detailService.detailForUser(
          { role: 'CUSTOMER', userId: 'someone-else' },
          'req-1',
        ),
      ).rejects.toThrow('You do not have access to this rescue request');
    });
  });

  describe('adminList', () => {
    let service: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { findMany: jest.Mock; count: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findMany: jest.fn(), count: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
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
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it("filters to refund-eligible requests when refundEligible=true is passed, matching refundDeposit's own eligibility condition (status CANCELLED + a succeeded deposit + no active/succeeded refund)", async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([]);
      prisma.rescueRequest.count.mockResolvedValue(0);

      await service.adminList({ refundEligible: 'true' });

      expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CANCELLED',
            AND: [
              {
                payments: {
                  some: { type: 'DEPOSIT', status: 'SUCCEEDED' },
                  none: {
                    type: 'REFUND',
                    status: {
                      in: ['PENDING', 'SUBMITTED', 'BLOCKED', 'SUCCEEDED'],
                    },
                  },
                },
              },
            ],
          }),
        }),
      );
    });

    it('derives depositPaid, balancePaid, and depositRefundStatus from the payments relation', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'CANCELLED',
          vehicleType: null,
          destination: null,
          latitude: null,
          longitude: null,
          payments: [{ id: 'pay-1', type: 'DEPOSIT', status: 'SUCCEEDED' }],
          customer: { id: 'cust-1', phoneNumber: '+2341' },
          assignedOperator: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      prisma.rescueRequest.count.mockResolvedValue(1);

      const result = await service.adminList({});

      expect(result.data[0].depositPaid).toBe(true);
      expect(result.data[0].balancePaid).toBe(false);
      // CANCELLED + a succeeded deposit + no refund attempt yet = ELIGIBLE.
      expect(result.data[0].depositRefundStatus).toBe('ELIGIBLE');
    });

    it('combines depositPaid and balancePaid filters instead of one overwriting the other', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([]);
      prisma.rescueRequest.count.mockResolvedValue(0);

      await service.adminList({ depositPaid: 'true', balancePaid: 'false' });

      expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              { payments: { some: { type: 'DEPOSIT', status: 'SUCCEEDED' } } },
              { payments: { none: { type: 'BALANCE', status: 'SUCCEEDED' } } },
            ],
          }),
        }),
      );
    });
  });

  describe('assignOperator', () => {
    let assignService: RescueRequestAdminService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
      dispatchOffer: {
        create: jest.Mock;
        delete: jest.Mock;
        update: jest.Mock;
      };
      payment: { update: jest.Mock };
    };
    let paymentLedger: PaymentLedgerMock;
    let paystackService: {
      initializePayment: jest.Mock;
    };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let dispatchService: { startDispatch: jest.Mock };
    let sharedService: { scheduleDepositWindow: jest.Mock };

    const operator = {
      id: 'op-1',
      status: 'ACTIVE',
      businessName: 'Acme Towing',
      phoneNumber: '+2348011111111',
    };
    const request = {
      id: 'req-1',
      status: 'DISPATCHING',
      customerId: 'cust-1',
      customer: { id: 'cust-1', phoneNumber: '+2348022222222', email: null },
    };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn().mockResolvedValue(operator) },
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue(request),
          update: jest.fn().mockImplementation(({ data }) => ({
            ...request,
            ...data,
            assignedOperator: operator,
            payments: [],
          })),
        },
        dispatchOffer: {
          create: jest.fn().mockResolvedValue({ id: 'offer-1' }),
          delete: jest.fn(),
          update: jest.fn(),
        },
        payment: { update: jest.fn() },
      };
      paymentLedger = createPaymentLedgerMock();
      paystackService = {
        initializePayment: jest.fn().mockResolvedValue({
          outcome: 'ok',
          data: {
            authorization_url: 'https://paystack.test/pay/xyz',
            access_code: 'acc_1',
            reference: 'DEP_pay-1',
          },
        }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = {
        getConfig: jest
          .fn()
          .mockResolvedValue({ serviceFeePercent: 10, depositPercent: 20 }),
      };
      dispatchService = {
        startDispatch: jest.fn().mockResolvedValue(undefined),
      };
      sharedService = { scheduleDepositWindow: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaymentLedgerService, useValue: paymentLedger },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: twilioService },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: dispatchService },
          { provide: RescueRequestSharedService, useValue: sharedService },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      assignService = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it('splits the price into service fee, deposit, and balance, and creates a payment link', async () => {
      // price 100_000 kobo, 10% fee -> total 110_000, 20% deposit -> 22_000 deposit, 88_000 balance
      const result = await assignService.assignOperator('req-1', {
        operatorId: 'op-1',
        priceKobo: 100_000,
      });

      expect(prisma.dispatchOffer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'SELECTED_PENDING_PAYMENT',
          quotedPrice: 100_000,
        }),
      });
      // The reference is the ledger row's id, not a generated one, so a
      // webhook can always find the payment it belongs to.
      expect(paystackService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 22_000, reference: 'DEP_pay-1' }),
      );
      // Persisted before the link is sent — once the customer can act on it,
      // recovery must never fail this attempt.
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { checkoutUrl: 'https://paystack.test/pay/xyz' },
      });
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assignedOperatorId: 'op-1',
            status: 'WAITING_FOR_DEPOSIT',
            serviceFeeAmount: 10_000,
            depositAmount: 22_000,
            balanceAmount: 88_000,
          }),
        }),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('https://paystack.test/pay/xyz'),
      );
      expect(result.data).toBeDefined();
    });

    it('rejects a non-active operator', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        ...operator,
        status: 'PENDING',
      });

      await expect(
        assignService.assignOperator('req-1', {
          operatorId: 'op-1',
          priceKobo: 100_000,
        }),
      ).rejects.toThrow('Target is not an active operator');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('rejects a non-positive price (ValidationPipe is not wired up, so this is enforced manually)', async () => {
      await expect(
        assignService.assignOperator('req-1', {
          operatorId: 'op-1',
          priceKobo: 0,
        }),
      ).rejects.toThrow('priceKobo must be a positive integer');
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the customer has no phone number on file', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...request,
        customer: { ...request.customer, phoneNumber: null },
      });

      await expect(
        assignService.assignOperator('req-1', {
          operatorId: 'op-1',
          priceKobo: 100_000,
        }),
      ).rejects.toThrow('Customer has no phone number on file');
    });

    it('rolls back the created offer when Paystack definitively rejects the link', async () => {
      paystackService.initializePayment.mockResolvedValue({
        outcome: 'rejected',
        code: 'invalid_params',
        message: 'Invalid amount',
      });

      await expect(
        assignService.assignOperator('req-1', {
          operatorId: 'op-1',
          priceKobo: 100_000,
        }),
      ).rejects.toThrow(`Couldn't generate a payment link`);

      expect(prisma.dispatchOffer.delete).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
      });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      // Definitive: nothing landed, so FAILED is safe and a retry is legal.
      expect(paymentLedger.recordRejection).toHaveBeenCalledWith(
        'pay-1',
        'Invalid amount',
      );
    });

    it('does not fail the payment when the link result is ambiguous, and tells the admin not to retry', async () => {
      // A 5xx or a timeout may still have created a transaction. Failing the
      // row here would make a retry legal and bill the customer twice, so the
      // row stays SUBMITTED for verification and only the offer rolls back.
      paystackService.initializePayment.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'gateway timeout',
      });

      await expect(
        assignService.assignOperator('req-1', {
          operatorId: 'op-1',
          priceKobo: 100_000,
        }),
      ).rejects.toThrow('Do not retry yet');

      expect(prisma.dispatchOffer.delete).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
      });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      // No checkoutUrl: the pair (SUBMITTED, null) is what tells recovery no
      // link ever reached the customer.
      expect(prisma.payment.update).not.toHaveBeenCalled();
      // The load-bearing one. FAILED here would make a retry legal against a
      // transaction that may already exist at Paystack.
      expect(paymentLedger.recordRejection).not.toHaveBeenCalled();
    });

    it('opens the deposit window in the same write that starts it', async () => {
      await assignService.assignOperator('req-1', {
        operatorId: 'op-1',
        priceKobo: 100_000,
      });

      // One write, not two. A request that reaches WAITING_FOR_DEPOSIT
      // without a deadline is invisible to DepositExpiryCheck — it would
      // hold its operator forever — so the deadline may never be a
      // follow-up statement that a crash can skip.
      expect(prisma.rescueRequest.update).toHaveBeenCalledTimes(1);
      const [{ data }] = prisma.rescueRequest.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data.status).toBe('WAITING_FOR_DEPOSIT');
      expect(data.depositWindowExpiresAt).toBeInstanceOf(Date);
      expect(data.depositRemindersSent).toBe(0);
    });
  });

  describe('refundDeposit', () => {
    let service: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      payment: { update: jest.Mock };
    };
    let paystackService: { refundTransaction: jest.Mock };
    let paymentLedger: PaymentLedgerMock;

    /** A CANCELLED request with a succeeded deposit — the eligible case. */
    const eligibleRequest = (overrides: Record<string, unknown> = {}) => ({
      id: 'req-1',
      status: 'CANCELLED',
      depositAmount: 500000,
      payments: [{ id: 'dep-1', type: 'DEPOSIT', status: 'SUCCEEDED' }],
      ...overrides,
    });

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        payment: { update: jest.fn().mockResolvedValue({}) },
      };
      paystackService = { refundTransaction: jest.fn() };
      paymentLedger = createPaymentLedgerMock();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaymentLedgerService, useValue: paymentLedger },
          {
            provide: PaystackCustomerService,
            useValue: createPaystackCustomerServiceMock(),
          },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it("refunds against the deposit payment's OWN reference, and stores the provider refund id", async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { id: 999, status: 'pending' },
      });

      await service.refundDeposit('req-1');

      expect(paymentLedger.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        type: 'REFUND',
        amount: 500000,
      });
      // referenceFor(depositPayment) — the deposit's OWN reference, not a
      // stored RescueRequest column, and the BARE Payment.id as the note.
      expect(paystackService.refundTransaction).toHaveBeenCalledWith({
        transaction: 'DEP_dep-1',
        amount: 500000,
        merchantNote: 'pay-1',
      });
      // Namespaced, and written before anything else — it is how the refund
      // webhook finds this row. There is no separate depositRefundId column
      // any more; this providerRef IS the refund's recorded identity.
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { providerRef: 'refund:999' },
      });
    });

    it('does not claim SUCCEEDED even when the refund body says processed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { id: 999, status: 'processed' },
      });

      await service.refundDeposit('req-1');

      // Only a webhook or verification may settle it.
      expect(paymentLedger.claimTerminal).not.toHaveBeenCalled();
    });

    it('blocks when the refund needs customer details', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { id: 999, status: 'needs-attention' },
      });

      await service.refundDeposit('req-1');

      expect(paymentLedger.recordBlocked).toHaveBeenCalledWith(
        'pay-1',
        'NEEDS_CUSTOMER_DETAILS',
      );
    });

    it('rejects with BadRequestException when the request was never CANCELLED — not eligible', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(
        eligibleRequest({ status: 'COMPLETED' }),
      );

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'Not eligible for refund',
      );
      expect(paymentLedger.create).not.toHaveBeenCalled();
    });

    it('rejects with BadRequestException when no deposit ever succeeded', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(
        eligibleRequest({ payments: [] }),
      );

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'Not eligible for refund',
      );
    });

    it('rejects when a refund is already active or has already succeeded — but a FAILED attempt stays retryable', async () => {
      const withActiveRefund = eligibleRequest({
        payments: [
          { id: 'dep-1', type: 'DEPOSIT', status: 'SUCCEEDED' },
          { id: 'ref-1', type: 'REFUND', status: 'SUBMITTED' },
        ],
      });
      prisma.rescueRequest.findUnique.mockResolvedValue(withActiveRefund);

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'Not eligible for refund',
      );
    });

    it('permits a retry after a FAILED refund attempt — a failed row is history, not a claim', async () => {
      const withFailedRefund = eligibleRequest({
        payments: [
          { id: 'dep-1', type: 'DEPOSIT', status: 'SUCCEEDED' },
          { id: 'ref-1', type: 'REFUND', status: 'FAILED' },
        ],
      });
      prisma.rescueRequest.findUnique.mockResolvedValue(withFailedRefund);
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'ok',
        data: { id: 999, status: 'pending' },
      });

      await expect(service.refundDeposit('req-1')).resolves.toBeUndefined();
      expect(paymentLedger.create).toHaveBeenCalled();
    });

    it('rejects when the in-flight index refuses a concurrent refund attempt', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      const p2002 = Object.assign(new Error('duplicate'), { code: 'P2002' });
      Object.setPrototypeOf(
        p2002,
        Prisma.PrismaClientKnownRequestError.prototype,
      );
      paymentLedger.create.mockRejectedValue(p2002);

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'A refund is already in progress for this request',
      );
      expect(paystackService.refundTransaction).not.toHaveBeenCalled();
    });

    it('never fails an ambiguous refund — a second attempt would refund twice', async () => {
      // The old code marked the request FAILED whenever the Paystack call
      // threw, and FAILED is retryable — but refunds have no
      // duplicate-reference protection, so the retry issues a SECOND real
      // refund.
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'ambiguous',
        message: 'socket hang up',
      });

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'Do not retry yet',
      );

      expect(paymentLedger.recordRejection).not.toHaveBeenCalled();
    });

    it('fails the row on a definitive rejection — nothing was created, so a fresh attempt is legal', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(eligibleRequest());
      paystackService.refundTransaction.mockResolvedValue({
        outcome: 'rejected',
        code: 'transaction_not_found',
        message: 'Transaction not found',
      });

      await expect(service.refundDeposit('req-1')).rejects.toThrow(
        'Refund failed: Transaction not found',
      );

      expect(paymentLedger.recordRejection).toHaveBeenCalledWith(
        'pay-1',
        'Transaction not found',
      );
    });

    describe('getDepositAmount', () => {
      it("returns the request's deposit amount", async () => {
        prisma.rescueRequest.findUnique.mockResolvedValue({
          depositAmount: 500000,
        });

        const result = await service.getDepositAmount('req-1');

        expect(prisma.rescueRequest.findUnique).toHaveBeenCalledWith({
          where: { id: 'req-1' },
          select: { depositAmount: true },
        });
        expect(result).toBe(500000);
      });

      it('returns null when the request does not exist', async () => {
        prisma.rescueRequest.findUnique.mockResolvedValue(null);

        expect(await service.getDepositAmount('missing')).toBeNull();
      });
    });
  });

  describe('adminList — dispute field mapping', () => {
    let service: RescueRequestAdminService;
    let prisma: { rescueRequest: { findMany: jest.Mock; count: jest.Mock } };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          findMany: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
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
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it('does not drop dispute fields from the list response', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'IN_DISPUTE',
          issueType: null,
          latitude: null,
          longitude: null,
          payments: [{ id: 'dep-1', type: 'DEPOSIT', status: 'SUCCEEDED' }],
          customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
          assignedOperator: null,
          disputed: true,
          disputeRaisedAt: new Date('2026-01-01'),
          disputeResolvedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await service.adminList({});

      expect(result.data[0].disputed).toBe(true);
      expect(result.data[0].disputeRaisedAt).toEqual(new Date('2026-01-01'));
      expect(result.data[0].disputeResolvedAt).toBeUndefined();
    });
  });

  describe('cancel', () => {
    type DispatchOfferUpdateManyArgs = {
      where: { rescueRequestId: string; status: string };
      data: { status: string; respondedAt: Date };
    };

    let service: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { update: jest.Mock };
      dispatchOffer: {
        updateMany: jest.Mock<void, [DispatchOfferUpdateManyArgs]>;
      };
    };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let sessionStore: { clear: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { update: jest.fn() },
        dispatchOffer: {
          updateMany: jest.fn<void, [DispatchOfferUpdateManyArgs]>(),
        },
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      sessionStore = { clear: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
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
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          {
            provide: RescueRequestSharedService,
            useValue: { endRelayForEndedRequest: jest.fn() },
          },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it('clears the customer session so a stale mid-flow state cannot loop after cancellation', async () => {
      prisma.rescueRequest.update.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        media: [],
        dispatchOffers: [],
        payments: [],
      });

      await service.cancel('req-1', {});

      expect(sessionStore.clear).toHaveBeenCalledWith('cust-1');
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('cancelled'),
      );
    });

    it("closes out other operators' still-PENDING offers on the cancelled job", async () => {
      prisma.rescueRequest.update.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        media: [],
        dispatchOffers: [],
        payments: [],
      });

      await service.cancel('req-1', {});

      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
    });

    it("closes out other operators' already-QUOTED offers too, not just PENDING — otherwise a leftover QUOTED row can still reach the customer after cancellation", async () => {
      prisma.rescueRequest.update.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        media: [],
        dispatchOffers: [],
        payments: [],
      });

      await service.cancel('req-1', {});

      const [, quotedCall] = prisma.dispatchOffer.updateMany.mock.calls;
      expect(quotedCall[0].where).toEqual({
        rescueRequestId: 'req-1',
        status: 'QUOTED',
      });
      expect(quotedCall[0].data.status).toBe('NOT_SELECTED');
      expect(quotedCall[0].data.respondedAt).toBeInstanceOf(Date);
    });
  });

  describe('updateStatus', () => {
    type DispatchOfferUpdateManyArgs = {
      where: { rescueRequestId: string; status: string };
      data: { status: string; respondedAt: Date };
    };

    let service: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { update: jest.Mock };
      dispatchOffer: {
        updateMany: jest.Mock<void, [DispatchOfferUpdateManyArgs]>;
      };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { update: jest.fn() },
        dispatchOffer: {
          updateMany: jest.fn<void, [DispatchOfferUpdateManyArgs]>(),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
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
          {
            provide: TwilioService,
            useValue: { sendWhatsAppMessage: jest.fn() },
          },
          { provide: PlatformConfigService, useValue: {} },
          {
            provide: PaymentEventsService,
            useValue: { markJobCompleted: jest.fn() },
          },
          { provide: DispatchService, useValue: {} },
          {
            provide: RescueRequestSharedService,
            useValue: { endRelayForEndedRequest: jest.fn() },
          },
          { provide: WhatsAppSessionStore, useValue: {} },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    it('closes out both PENDING and QUOTED offers when moving a request to CANCELLED', async () => {
      prisma.rescueRequest.update.mockResolvedValue({
        id: 'req-1',
        customerId: 'cust-1',
        status: 'CANCELLED',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        media: [],
        dispatchOffers: [],
        payments: [],
      });

      await service.updateStatus('req-1', { status: 'CANCELLED' });

      const [pendingCall, quotedCall] =
        prisma.dispatchOffer.updateMany.mock.calls;
      expect(pendingCall[0].where).toEqual({
        rescueRequestId: 'req-1',
        status: 'PENDING',
      });
      expect(pendingCall[0].data.status).toBe('TIMED_OUT');
      expect(pendingCall[0].data.respondedAt).toBeInstanceOf(Date);
      expect(quotedCall[0].where).toEqual({
        rescueRequestId: 'req-1',
        status: 'QUOTED',
      });
      expect(quotedCall[0].data.status).toBe('NOT_SELECTED');
      expect(quotedCall[0].data.respondedAt).toBeInstanceOf(Date);
    });
  });
});
