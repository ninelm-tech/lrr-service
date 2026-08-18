import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { RescueRequestService } from './rescue-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PaymentEventsService } from './payment-events.service';

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
          { provide: RescueRequestService, useValue: {} },
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
    let rescueRequestService: { startDispatch: jest.Mock };

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
      rescueRequestService = { startDispatch: jest.fn().mockResolvedValue(undefined) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: paystackService },
          { provide: TwilioService, useValue: twilioService },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: RescueRequestService, useValue: rescueRequestService },
        ],
      }).compile();

      assignService = module.get<RescueRequestAdminService>(RescueRequestAdminService);
    });

    it('splits the price into service fee, deposit, and balance, and creates a payment link', async () => {
      // Fake timers so the 5-minute deposit-window setTimeout this schedules
      // never becomes a real leaked OS timer.
      jest.useFakeTimers();
      try {
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
      } finally {
        jest.useRealTimers();
      }
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

    it('releases the operator and reopens dispatch if the deposit window expires unpaid', async () => {
      jest.useFakeTimers();
      try {
        prisma.rescueRequest.findUnique
          .mockResolvedValueOnce(request) // initial lookup inside assignOperator
          .mockResolvedValueOnce({ status: 'WAITING_FOR_DEPOSIT' }); // still-unpaid check in the timeout

        await assignService.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 100_000 });

        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: expect.objectContaining({ status: 'TIMED_OUT' }),
        });
        expect(prisma.rescueRequest.update).toHaveBeenLastCalledWith({
          where: { id: 'req-1' },
          data: { assignedOperatorId: null, status: 'DISPATCHING' },
        });
        expect(rescueRequestService.startDispatch).toHaveBeenCalledWith('req-1', 'cust-1');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
