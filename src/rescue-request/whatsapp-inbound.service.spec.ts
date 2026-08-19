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
  let sharedService: { findOrCreateCustomer: jest.Mock };
  const phoneNumber = '+2348012345678';

  beforeEach(async () => {
    prisma = { operator: { findUnique: jest.fn().mockResolvedValue(null) } };
    sessionStore = { getOrCreate: jest.fn().mockResolvedValue({ state: 'IDLE' }) };
    operatorFlowService = { handleOperatorMessage: jest.fn().mockResolvedValue('operator-reply') };
    customerFlowService = { handleCustomerMessage: jest.fn().mockResolvedValue('customer-reply') };
    sharedService = { findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'user-1' }) };

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
    prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', businessName: 'Swift Towing', phoneNumber });

    const result = await service.handleIncomingWhatsAppMessage({ From: `whatsapp:${phoneNumber}`, Body: 'hi' });

    expect(sharedService.findOrCreateCustomer).toHaveBeenCalledWith(phoneNumber);
    expect(operatorFlowService.handleOperatorMessage).toHaveBeenCalledWith(
      phoneNumber, 'user-1', 'hi', { state: 'IDLE' }, { id: 'op-1', businessName: 'Swift Towing', phoneNumber },
    );
    expect(customerFlowService.handleCustomerMessage).not.toHaveBeenCalled();
    expect(result).toBe('operator-reply');
  });

  it('routes to WhatsAppCustomerFlowService when the sender is not a known operator', async () => {
    const body = { From: `whatsapp:${phoneNumber}`, Body: 'HELP' };

    const result = await service.handleIncomingWhatsAppMessage(body);

    expect(customerFlowService.handleCustomerMessage).toHaveBeenCalledWith(
      phoneNumber, 'user-1', 'help', 'HELP', undefined, undefined, undefined, { state: 'IDLE' }, body,
    );
    expect(operatorFlowService.handleOperatorMessage).not.toHaveBeenCalled();
    expect(result).toBe('customer-reply');
  });
});
