import { Test, TestingModule } from '@nestjs/testing';
import { DisputeService } from './dispute.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('DisputeService', () => {
  let service: DisputeService;
  let prisma: {
    $transaction: jest.Mock;
    user: { updateMany: jest.Mock };
    operator: { updateMany: jest.Mock };
    rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
    payment: { findFirst: jest.Mock };
  };
  let twilioService: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
  };
  let platformConfigService: { getConfig: jest.Mock };
  let sessionStore: { update: jest.Mock };
  let sharedService: { findOrCreateCustomer: jest.Mock };
  let paymentEventsService: { sendBalancePaymentLink: jest.Mock };
  const originalTemplateSid = process.env.TWILIO_DISPUTE_TEMPLATE_SID;

  const rescueRequestId = 'req-1';
  const customerPhone = '+2348012345678';
  const operatorPhone = '+2348011112222';

  beforeEach(async () => {
    delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    prisma = {
      $transaction: jest.fn(),
      user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      operator: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      rescueRequest: { findUnique: jest.fn(), update: jest.fn() },
      payment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    twilioService = {
      sendWhatsAppMessage: jest.fn(),
      sendWhatsAppTemplateMessage: jest.fn(),
    };
    platformConfigService = {
      getConfig: jest.fn().mockResolvedValue({ disputeAlertPhoneNumber: null }),
    };
    sessionStore = { update: jest.fn() };
    sharedService = {
      findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }),
    };
    paymentEventsService = { sendBalancePaymentLink: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilioService },
        { provide: PlatformConfigService, useValue: platformConfigService },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestSharedService, useValue: sharedService },
        { provide: PaymentEventsService, useValue: paymentEventsService },
      ],
    }).compile();

    service = module.get<DisputeService>(DisputeService);
  });

  afterEach(() => {
    if (originalTemplateSid === undefined)
      delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    else process.env.TWILIO_DISPUTE_TEMPLATE_SID = originalTemplateSid;
  });

  describe('raiseDispute', () => {
    it('first raise: sets status IN_DISPUTE + disputed + disputeRaisedAt', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
        status: 'ARRIVED',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
        balanceAmount: 22500,
        depositAmount: 2500,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumber: null,
      });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputed: true,
          disputeRaisedAt: expect.any(Date),
          disputeResolvedAt: null,
          status: 'IN_DISPUTE',
        },
      });
    });

    it('first raise: puts the customer session into AWAITING_DISPUTE_REASON', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
        status: 'ARRIVED',
        assignedOperator: null,
        balanceAmount: 22500,
        depositAmount: 2500,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId,
      });
    });

    it('first raise: puts the operator session into AWAITING_DISPUTE_RESPONSE and asks for their side', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
        status: 'ARRIVED',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
        balanceAmount: 22500,
        depositAmount: 2500,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(sharedService.findOrCreateCustomer).toHaveBeenCalledWith(
        operatorPhone,
      );
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
        rescueRequestId,
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('your side'),
      );
    });

    it('asks the customer for their side of the story, including the call-in number when configured', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
        status: 'ARRIVED',
        assignedOperator: null,
        balanceAmount: 22500,
        depositAmount: 2500,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumber: '+2348099999999',
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      const customerCall = twilioService.sendWhatsAppMessage.mock.calls.find(
        ([to]) => to.includes(customerPhone),
      );
      expect(customerCall?.[1]).toContain('what happened');
      expect(customerCall?.[1]).toContain('+2348099999999');
    });

    it('first raise: warns the operator (not the customer) to withhold the vehicle', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
        status: 'ARRIVED',
        assignedOperator: {
          businessName: 'Swift Towing',
          phoneNumber: operatorPhone,
        },
        balanceAmount: 22500,
        depositAmount: 2500,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumber: null,
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('Do NOT release the vehicle'),
      );
      const customerCall = twilioService.sendWhatsAppMessage.mock.calls.find(
        ([to]) => to.includes(customerPhone),
      );
      expect(customerCall?.[1]).not.toContain('vehicle');
    });

    it('repeat while unresolved: no DB write, no re-alert, distinct reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: null,
        status: 'IN_DISPUTE',
        assignedOperator: null,
        balanceAmount: null,
        depositAmount: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('already flagged'),
      );
    });

    it('reopen after resolution: clears disputeResolvedAt, refreshes disputeRaisedAt, status back to IN_DISPUTE, re-alerts staff', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: new Date('2026-01-01'),
        status: 'COMPLETED',
        assignedOperator: null,
        balanceAmount: null,
        depositAmount: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({
        disputeAlertPhoneNumber: '+2348099999999',
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputed: true,
          disputeRaisedAt: expect.any(Date),
          disputeResolvedAt: null,
          status: 'IN_DISPUTE',
        },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('reopened'),
      );
    });

    it('locks the customer before the assigned operator and updates inside the transaction', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        customerId: 'cust-1',
        assignedOperatorId: 'op-1',
        disputed: false,
        disputeResolvedAt: null,
        assignedOperator: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(prisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'cust-1', deletedAt: null } }),
      );
      expect(prisma.operator.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'op-1', deletedAt: null } }),
      );
      expect(prisma.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.operator.updateMany.mock.invocationCallOrder[0],
      );
      expect(prisma.rescueRequest.update).toHaveBeenCalled();
    });

    it('aborts without notifications when the customer has been deleted', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
      });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.raiseDispute(rescueRequestId, customerPhone, 'cust-1'),
      ).rejects.toThrow('customer has been deleted');

      expect(prisma.operator.updateMany).not.toHaveBeenCalled();
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('aborts without notifications when the assigned operator has been deleted', async () => {
      prisma.rescueRequest.findUnique
        .mockResolvedValueOnce({ customerId: 'cust-1' })
        .mockResolvedValueOnce({ assignedOperatorId: 'op-1' });
      prisma.operator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.raiseDispute(rescueRequestId, customerPhone, 'cust-1'),
      ).rejects.toThrow('assigned operator has been deleted');

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('does not notify until the dispute transaction has committed', async () => {
      let transactionFinished = false;
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        customerId: 'cust-1',
        assignedOperatorId: null,
        disputed: false,
        disputeResolvedAt: null,
        assignedOperator: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          const result = await callback(prisma);
          transactionFinished = true;
          return result;
        },
      );
      twilioService.sendWhatsAppMessage.mockImplementation(() => {
        expect(transactionFinished).toBe(true);
        return Promise.resolve();
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(transactionFinished).toBe(true);
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalled();
    });
  });

  describe('resolveDispute', () => {
    it('rejects when the request was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: false,
        disputeResolvedAt: null,
      });

      await expect(
        service.resolveDispute(rescueRequestId, 'looked into it'),
      ).rejects.toThrow('never been disputed');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range or non-integer percent without touching the DB', async () => {
      await expect(
        service.resolveDispute(rescueRequestId, 'note', 0),
      ).rejects.toThrow('between 1 and 100');
      await expect(
        service.resolveDispute(rescueRequestId, 'note', 101),
      ).rejects.toThrow('between 1 and 100');
      await expect(
        service.resolveDispute(rescueRequestId, 'note', 50.5),
      ).rejects.toThrow('between 1 and 100');
      expect(prisma.rescueRequest.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op when already resolved — no DB write, no payment link, no re-notification', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: new Date('2026-01-01'),
        customer: { phoneNumber: customerPhone },
        assignedOperator: null,
      });

      const result = await service.resolveDispute(rescueRequestId, 'note');

      expect(result).toEqual({ resolved: true });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(
        paymentEventsService.sendBalancePaymentLink,
      ).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('rejects when the balance was already paid in full — a reopened dispute must not collect a second payment', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: null,
        balanceAmount: 45000,
        customer: { phoneNumber: customerPhone },
        assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.payment.findFirst.mockResolvedValue({ id: 'pay-1' });

      await expect(
        service.resolveDispute(rescueRequestId, 'note', 10),
      ).rejects.toThrow('already been paid in full');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(
        paymentEventsService.sendBalancePaymentLink,
      ).not.toHaveBeenCalled();
    });

    it('resolves with no adjustment: settled balance equals the original, snapshot still written', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: null,
        balanceAmount: 45000,
        customer: { phoneNumber: customerPhone },
        assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        rescueRequestId,
        'operator was right, no change',
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputeResolvedAt: expect.any(Date),
          disputeResolutionNote: 'operator was right, no change',
          disputeOriginalBalanceAmount: 45000,
          balanceAmount: 45000,
        },
      });
      expect(paymentEventsService.sendBalancePaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ balanceAmount: 45000 }),
      );
      // Callers (the audit log entry) need both figures to show a
      // before/after — not just the update call's args.
      expect(result).toEqual({
        resolved: true,
        originalBalance: 45000,
        settledBalance: 45000,
      });
    });

    it('resolves with a 60% adjustment: settled balance is 60% of the original, both amounts stored', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: null,
        balanceAmount: 45000,
        customer: { phoneNumber: customerPhone },
        assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        rescueRequestId,
        'tow took too long, 60% agreed',
        60,
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputeResolvedAt: expect.any(Date),
          disputeResolutionNote: 'tow took too long, 60% agreed',
          disputeOriginalBalanceAmount: 45000,
          balanceAmount: 27000,
        },
      });
      expect(paymentEventsService.sendBalancePaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ balanceAmount: 27000 }),
      );
      expect(result).toEqual({
        resolved: true,
        originalBalance: 45000,
        settledBalance: 27000,
      });
    });

    it('notifies the operator that the settlement link was sent, best-effort on Twilio failure', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId,
        disputed: true,
        disputeResolvedAt: null,
        balanceAmount: 45000,
        customer: { phoneNumber: customerPhone },
        assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      twilioService.sendWhatsAppMessage.mockRejectedValueOnce(
        new Error('Twilio down'),
      );

      await expect(
        service.resolveDispute(rescueRequestId, 'note'),
      ).resolves.toEqual({
        resolved: true,
        originalBalance: 45000,
        settledBalance: 45000,
      });

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('resolved'),
      );
    });
  });
});
