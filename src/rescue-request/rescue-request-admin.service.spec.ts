import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PaymentEventsService } from './payment-events.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import * as Sentry from '@sentry/node';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

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
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      detailService = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    const baseRaw = {
      id: 'req-1',
      status: 'DISPATCHING',
      issueType: undefined,
      vehicleType: 'SEDAN',
      destination: 'Mainland',
      latitude: null,
      longitude: null,
      depositPaid: false,
      depositAmount: undefined,
      depositReference: undefined,
      balancePaid: false,
      balanceAmount: undefined,
      balanceReference: undefined,
      createdAt: new Date('2026-08-10T00:00:00Z'),
      updatedAt: new Date('2026-08-10T00:00:00Z'),
      customer: { id: 'cust-1', phoneNumber: '+2340000000000', email: null, name: null },
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
      platformConfigService.getConfig.mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 });

      const result = await detailService.detailForUser({ role: 'ADMIN', userId: 'admin-1' }, 'req-1');

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
          { id: 'rating-1', direction: 'MOTORIST_TO_OPERATOR', score: 1, comment: null, flagged: true, flaggedAt: new Date('2026-01-01'), flaggedResolvedAt: null },
        ],
      });
      platformConfigService.getConfig.mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 });

      const result = await detailService.detailForUser({ role: 'ADMIN', userId: 'admin-1' }, 'req-1');

      expect(result.data.ratings).toEqual([
        expect.objectContaining({ id: 'rating-1', score: 1, flagged: true, flaggedResolvedAt: undefined }),
      ]);
    });

    it('omits offers entirely for OPERATOR', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        assignedOperatorId: 'op-1',
        assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111', email: null },
      });
      prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

      const result = await detailService.detailForUser({ role: 'OPERATOR', userId: 'user-1' }, 'req-1');

      expect(result.data.offers).toBeUndefined();
    });

    it('returns data for a CUSTOMER who owns the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      const result = await detailService.detailForUser({ role: 'CUSTOMER', userId: 'cust-1' }, 'req-1');

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.offers).toBeUndefined();
    });

    it('rejects a CUSTOMER who does not own the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      await expect(
        detailService.detailForUser({ role: 'CUSTOMER', userId: 'someone-else' }, 'req-1'),
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
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    it('filters to refund-eligible requests when refundEligible=true is passed, matching refundDeposit\'s own claim condition (status CANCELLED + depositRefundStatus)', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([]);
      prisma.rescueRequest.count.mockResolvedValue(0);

      await service.adminList({ refundEligible: 'true' });

      expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CANCELLED',
            depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] },
          }),
        }),
      );
    });

    it('includes depositRefundStatus in each list item', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([{
        id: 'req-1', status: 'CANCELLED', vehicleType: null, destination: null,
        latitude: null, longitude: null, depositPaid: true, balancePaid: false,
        depositRefundStatus: 'ELIGIBLE',
        customer: { id: 'cust-1', phoneNumber: '+2341' }, assignedOperator: null,
        createdAt: new Date(), updatedAt: new Date(),
      }]);
      prisma.rescueRequest.count.mockResolvedValue(1);

      const result = await service.adminList({});

      expect(result.data[0].depositRefundStatus).toBe('ELIGIBLE');
    });
  });

  describe('assignOperator', () => {
    let assignService: RescueRequestAdminService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
      dispatchOffer: { create: jest.Mock; delete: jest.Mock; update: jest.Mock };
    };
    let paystackService: { generateReference: jest.Mock; initializePayment: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let platformConfigService: { getConfig: jest.Mock };
    let dispatchService: { startDispatch: jest.Mock };
    let sharedService: { scheduleDepositWindow: jest.Mock };

    const operator = { id: 'op-1', status: 'ACTIVE', businessName: 'Acme Towing', phoneNumber: '+2348011111111' };
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
          update: jest.fn().mockImplementation(({ data }) => ({ ...request, ...data, assignedOperator: operator })),
        },
        dispatchOffer: {
          create: jest.fn().mockResolvedValue({ id: 'offer-1' }),
          delete: jest.fn(),
          update: jest.fn(),
        },
      };
      paystackService = {
        generateReference: jest.fn().mockReturnValue('DEP_ref123'),
        initializePayment: jest.fn().mockResolvedValue({
          status: true,
          data: { authorization_url: 'https://paystack.test/pay/xyz' },
        }),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      platformConfigService = {
        getConfig: jest.fn().mockResolvedValue({ serviceFeePercent: 10, depositPercent: 20 }),
      };
      dispatchService = { startDispatch: jest.fn().mockResolvedValue(undefined) };
      sharedService = { scheduleDepositWindow: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: twilioService },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: dispatchService },
          { provide: RescueRequestSharedService, useValue: sharedService },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      assignService = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    it('splits the price into service fee, deposit, and balance, and creates a payment link', async () => {
      // price 100_000 kobo, 10% fee -> total 110_000, 20% deposit -> 22_000 deposit, 88_000 balance
      const result = await assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 });

      expect(prisma.dispatchOffer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          status: 'SELECTED_PENDING_PAYMENT',
          quotedPrice: 100_000,
        }),
      });
      expect(paystackService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 22_000 }),
      );
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
      prisma.operator.findUnique.mockResolvedValue({ ...operator, status: 'PENDING' });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow('Target is not an active operator');
      expect(prisma.dispatchOffer.create).not.toHaveBeenCalled();
    });

    it('rejects a non-positive price (ValidationPipe is not wired up, so this is enforced manually)', async () => {
      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 0 }),
      ).rejects.toThrow('priceKobo must be a positive integer');
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the customer has no phone number on file', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...request,
        customer: { ...request.customer, phoneNumber: null },
      });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow('Customer has no phone number on file');
    });

    it('rolls back the created offer if the payment link fails to generate', async () => {
      paystackService.initializePayment.mockResolvedValue({ status: false });

      await expect(
        assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 }),
      ).rejects.toThrow(`Couldn't generate a payment link`);

      expect(prisma.dispatchOffer.delete).toHaveBeenCalledWith({ where: { id: 'offer-1' } });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('schedules the deposit window via the shared service', async () => {
      await assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 });

      expect(sharedService.scheduleDepositWindow).toHaveBeenCalledWith({
        rescueRequestId: 'req-1',
        customerId: 'cust-1',
        customerPhone: expect.any(String),
        operatorPhone: expect.any(String),
        paymentUrl: 'https://paystack.test/pay/xyz',
      });
    });
  });

  describe('refundDeposit', () => {
    let service: RescueRequestAdminService;
    let prisma: {
      rescueRequest: {
        updateMany: jest.Mock;
        findUniqueOrThrow: jest.Mock;
        update: jest.Mock;
      };
    };
    let paystackService: { refundTransaction: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: {
          updateMany: jest.fn(),
          findUniqueOrThrow: jest.fn(),
          update: jest.fn(),
        },
      };
      paystackService = { refundTransaction: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(RescueRequestAdminService);
      (Sentry.captureException as jest.Mock).mockClear();
    });

    it('claims ELIGIBLE → PENDING, calls Paystack, stores the refund id', async () => {
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', depositReference: 'DEP_ref_1', depositAmount: 500000,
      });
      paystackService.refundTransaction.mockResolvedValue({ id: 999, status: 'pending' });
      prisma.rescueRequest.update.mockResolvedValue({});

      await service.refundDeposit('req-1');

      expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', status: 'CANCELLED', depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] } },
        data: { depositRefundStatus: 'PENDING' },
      });
      expect(paystackService.refundTransaction).toHaveBeenCalledWith('DEP_ref_1', 500000);
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { depositRefundId: 999 },
      });
    });

    it('rejects the claim (BadRequestException) when depositRefundStatus is NONE — not eligible', async () => {
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.refundDeposit('req-1')).rejects.toThrow('Not eligible for refund');
    });

    it('marks FAILED and rethrows when the Paystack call throws', async () => {
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', depositReference: 'DEP_ref_1', depositAmount: 500000,
      });
      paystackService.refundTransaction.mockRejectedValue(new Error('Paystack down'));

      await expect(service.refundDeposit('req-1')).rejects.toThrow('Paystack down');
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { depositRefundStatus: 'FAILED' },
      });
    });

    it('leaves depositRefundStatus at PENDING (not FAILED) and alerts Sentry when Paystack succeeds but the depositRefundId write throws — a retry here would double-refund', async () => {
      prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'req-1', depositReference: 'DEP_ref_1', depositAmount: 500000,
      });
      paystackService.refundTransaction.mockResolvedValue({ id: 999, status: 'success' });
      prisma.rescueRequest.update.mockRejectedValue(new Error('DB write failed'));

      await expect(service.refundDeposit('req-1')).resolves.toBeUndefined();

      // Only the initial PENDING claim write happened — no FAILED write.
      expect(prisma.rescueRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { depositRefundId: 999 },
      });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { depositRefundStatus: 'FAILED' } }),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ rescueRequestId: 'req-1', refundId: 999 }),
        }),
      );
    });
  });

  describe('adminList — dispute field mapping', () => {
    let service: RescueRequestAdminService;
    let prisma: { rescueRequest: { findMany: jest.Mock; count: jest.Mock } };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(1) },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    it('does not drop dispute fields from the list response', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([{
        id: 'req-1', status: 'IN_DISPUTE', issueType: null, latitude: null, longitude: null,
        depositPaid: true, balancePaid: false, depositRefundStatus: 'NONE',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        assignedOperator: null,
        disputed: true, disputeRaisedAt: new Date('2026-01-01'), disputeResolvedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      }]);

      const result = await service.adminList({});

      expect(result.data[0].disputed).toBe(true);
      expect(result.data[0].disputeRaisedAt).toEqual(new Date('2026-01-01'));
      expect(result.data[0].disputeResolvedAt).toBeUndefined();
    });
  });

  describe('cancel', () => {
    let service: RescueRequestAdminService;
    let prisma: { rescueRequest: { update: jest.Mock } };
    let twilioService: { sendWhatsAppMessage: jest.Mock };
    let sessionStore: { clear: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { update: jest.fn() } };
      twilioService = { sendWhatsAppMessage: jest.fn() };
      sessionStore = { clear: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
          { provide: PlatformConfigService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
        ],
      }).compile();

      service = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    it('clears the customer session so a stale mid-flow state cannot loop after cancellation', async () => {
      prisma.rescueRequest.update.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', status: 'CANCELLED',
        customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
        media: [], dispatchOffers: [],
      });

      await service.cancel('req-1', {});

      expect(sessionStore.clear).toHaveBeenCalledWith('cust-1');
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('cancelled'),
      );
    });
  });
});
