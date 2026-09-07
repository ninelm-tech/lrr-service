import { Test, TestingModule } from '@nestjs/testing';
import { DisputeService } from './dispute.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';

describe('DisputeService', () => {
  let service: DisputeService;
  let prisma: {
    rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
  };
  let twilioService: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
  let platformConfigService: { getConfig: jest.Mock };
  const originalTemplateSid = process.env.TWILIO_DISPUTE_TEMPLATE_SID;

  const rescueRequestId = 'req-1';
  const customerPhone = '+2348012345678';

  beforeEach(async () => {
    delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    prisma = {
      rescueRequest: { findUnique: jest.fn(), update: jest.fn() },
    };
    twilioService = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };
    platformConfigService = { getConfig: jest.fn().mockResolvedValue({ disputeAlertPhoneNumber: null }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilioService },
        { provide: PlatformConfigService, useValue: platformConfigService },
      ],
    }).compile();

    service = module.get<DisputeService>(DisputeService);
  });

  afterEach(() => {
    if (originalTemplateSid === undefined) delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    else process.env.TWILIO_DISPUTE_TEMPLATE_SID = originalTemplateSid;
  });

  describe('raiseDispute', () => {
    it('sends the staff alert via the approved Content Template when TWILIO_DISPUTE_TEMPLATE_SID is set', async () => {
      process.env.TWILIO_DISPUTE_TEMPLATE_SID = 'HXtest123';
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        'whatsapp:+2348099999999',
        'HXtest123',
        { '1': expect.any(String), '2': expect.stringContaining('/requests?highlight=') },
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1); // customer ack only, not the staff line
    });

    it('first raise: sets disputed + disputeRaisedAt, sends customer ack, alerts staff when configured', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing' },
        balanceAmount: 22500, depositAmount: 2500, customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date) },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('dispute has been logged'),
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        'whatsapp:+2348099999999',
        expect.stringContaining('New dispute raised'),
      );
    });

    it('first raise: warns the operator (not the customer) to withhold the vehicle', async () => {
      const operatorPhone = '+2348011112222';
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing', phoneNumber: operatorPhone },
        balanceAmount: 22500, depositAmount: 2500, customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('Do NOT release the vehicle'),
      );
      const customerCall = twilioService.sendWhatsAppMessage.mock.calls.find(
        ([to]) => to.includes(customerPhone),
      );
      expect(customerCall?.[1]).not.toContain('vehicle');
    });

    it('skips the staff alert cleanly when disputeAlertPhoneNumber is unset', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null, balanceAmount: 22500, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1); // customer ack only
    });

    it('repeat while unresolved: no DB write, no re-alert, distinct reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('already flagged'),
      );
    });

    it('reopen after resolution: clears disputeResolvedAt, refreshes disputeRaisedAt, re-alerts staff', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date), disputeResolvedAt: null },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('reopened'),
      );
    });
  });

  describe('resolveDispute', () => {
    it('rejects when the request was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: rescueRequestId, disputed: false, disputeResolvedAt: null });

      await expect(service.resolveDispute(rescueRequestId)).rejects.toThrow('never been disputed');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('is a no-op when already resolved — no DB write, no re-notification', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        customer: { phoneNumber: customerPhone }, assignedOperator: null,
      });

      const result = await service.resolveDispute(rescueRequestId);

      expect(result).toEqual({ resolved: true });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('resolves, notifies customer and assigned operator, best-effort on Twilio failure', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null,
        customer: { phoneNumber: customerPhone },
        assignedOperator: { phoneNumber: '+2348099999999' },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      twilioService.sendWhatsAppMessage.mockRejectedValueOnce(new Error('Twilio down'));

      await expect(service.resolveDispute(rescueRequestId)).resolves.toEqual({ resolved: true });

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputeResolvedAt: expect.any(Date) },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // customer + operator, even though first rejected
    });
  });
});
