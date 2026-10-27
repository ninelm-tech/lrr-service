import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';

describe('WhatsAppInboundService', () => {
  let service: WhatsAppInboundService;
  let prisma: { operator: { findUnique: jest.Mock } };
  let sessionStore: { getOrCreate: jest.Mock };
  let operatorFlowService: { handleOperatorMessage: jest.Mock };
  let customerFlowService: { handleCustomerMessage: jest.Mock };
  let sharedService: { findOrCreateBySender: jest.Mock };
  const phoneNumber = '+2348012345678';

  beforeEach(async () => {
    prisma = { operator: { findUnique: jest.fn().mockResolvedValue(null) } };
    sessionStore = {
      getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }),
    };
    operatorFlowService = {
      handleOperatorMessage: jest.fn().mockResolvedValue('operator-reply'),
    };
    customerFlowService = {
      handleCustomerMessage: jest.fn().mockResolvedValue('customer-reply'),
    };
    sharedService = {
      findOrCreateBySender: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', phoneNumber }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppInboundService,
        { provide: PrismaService, useValue: prisma },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: WhatsAppOperatorFlowService, useValue: operatorFlowService },
        { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
        { provide: RescueRequestSharedService, useValue: sharedService },
      ],
    }).compile();

    service = module.get<WhatsAppInboundService>(WhatsAppInboundService);
  });

  it('routes to WhatsAppOperatorFlowService when the sender is a known operator', async () => {
    prisma.operator.findUnique.mockResolvedValue({
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber,
      whatsappEnabled: true,
    });

    const inboundBody = {
      From: `whatsapp:${phoneNumber}`,
      Body: 'hi',
    };
    const result = await service.handleIncomingWhatsAppMessage(inboundBody);

    expect(sharedService.findOrCreateBySender).toHaveBeenCalledWith({
      phoneNumber,
      externalUserId: null,
    });
    expect(prisma.operator.findUnique).toHaveBeenCalledWith({
      where: { phoneNumber },
    });
    expect(operatorFlowService.handleOperatorMessage).toHaveBeenCalledWith(
      phoneNumber,
      'user-1',
      'hi',
      'hi',
      { state: 'IDLE' },
      {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber,
      },
      inboundBody,
    );
    expect(customerFlowService.handleCustomerMessage).not.toHaveBeenCalled();
    expect(result).toBe('operator-reply');
  });

  it('blocks a non-WhatsApp operator at the router — neither flow is touched', async () => {
    prisma.operator.findUnique.mockResolvedValue({
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber,
      whatsappEnabled: false,
    });

    const result = await service.handleIncomingWhatsAppMessage({
      From: `whatsapp:${phoneNumber}`,
      Body: 'hi',
    });

    expect(operatorFlowService.handleOperatorMessage).not.toHaveBeenCalled();
    expect(customerFlowService.handleCustomerMessage).not.toHaveBeenCalled();
    expect(result).toContain('<Response>');
    expect(result).toContain('contact LRR staff');
  });

  it('routes to WhatsAppCustomerFlowService when the sender is not a known operator', async () => {
    const body = { From: `whatsapp:${phoneNumber}`, Body: 'HELP' };

    const result = await service.handleIncomingWhatsAppMessage(body);

    expect(customerFlowService.handleCustomerMessage).toHaveBeenCalledWith(
      phoneNumber,
      'user-1',
      'help',
      'HELP',
      undefined,
      undefined,
      undefined,
      { state: 'IDLE' },
      body,
    );
    expect(operatorFlowService.handleOperatorMessage).not.toHaveBeenCalled();
    expect(result).toBe('customer-reply');
  });

  describe('BSUID routing', () => {
    it("routes a masked, previously-captured operator to the operator flow — matched by the resolved User's own on-file phoneNumber, not by staff/login membership", async () => {
      // The User resolved by BSUID still carries the real phoneNumber it was
      // passively captured against the last time this account messaged
      // unmasked — that's what the router now matches against Operator,
      // not any OperatorMember/staff-login relationship.
      sharedService.findOrCreateBySender.mockResolvedValue({
        id: 'user-1',
        phoneNumber,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        businessName: 'Swift Towing',
        whatsappEnabled: true,
        phoneNumber,
      });

      await service.handleIncomingWhatsAppMessage({
        From: 'whatsapp:CA.op1',
        Body: 'ARRIVED',
      });

      expect(prisma.operator.findUnique).toHaveBeenCalledWith({
        where: { phoneNumber },
      });
      expect(operatorFlowService.handleOperatorMessage).toHaveBeenCalledWith(
        phoneNumber,
        'user-1',
        'arrived',
        'ARRIVED',
        { state: 'IDLE' },
        {
          id: 'op-1',
          businessName: 'Swift Towing',
          phoneNumber,
        },
        { From: 'whatsapp:CA.op1', Body: 'ARRIVED' },
      );
      expect(customerFlowService.handleCustomerMessage).not.toHaveBeenCalled();
    });

    it('routes an unmatched BSUID sender to the customer flow, not a blocking reply', async () => {
      sharedService.findOrCreateBySender.mockResolvedValue({
        id: 'user-2',
        phoneNumber: null,
      });

      const result = await service.handleIncomingWhatsAppMessage({
        From: 'whatsapp:CA.brandnewcustomer',
        Body: 'SOS',
      });

      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(customerFlowService.handleCustomerMessage).toHaveBeenCalled();
      expect(operatorFlowService.handleOperatorMessage).not.toHaveBeenCalled();
      expect(result).toBe('customer-reply');
    });

    it('creates a phoneNumber: null customer for a fresh BSUID-only SOS sender', async () => {
      sharedService.findOrCreateBySender.mockResolvedValue({
        id: 'user-3',
        phoneNumber: null,
      });

      await service.handleIncomingWhatsAppMessage({
        From: 'whatsapp:CA.newcustomer',
        Body: 'SOS',
      });

      expect(sharedService.findOrCreateBySender).toHaveBeenCalledWith({
        phoneNumber: null,
        externalUserId: 'CA.newcustomer',
      });
    });

    it('rejects a sender resolving to neither a phone nor a BSUID, before ever creating a User for it', async () => {
      await expect(
        service.handleIncomingWhatsAppMessage({
          From: 'whatsapp:not-a-real-value',
          Body: 'hi',
        }),
      ).rejects.toThrow();

      expect(sharedService.findOrCreateBySender).not.toHaveBeenCalled();
    });
  });
});
