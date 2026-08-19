import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { DispatchService } from './dispatch.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('WhatsAppOperatorFlowService', () => {
  describe('handleOperatorMessage — rating branch ordering', () => {
    let orderingService: WhatsAppOperatorFlowService;
    let prisma: { operator: { findUnique: jest.Mock }; rescueRequest: { findUnique: jest.Mock } };
    let customerFlowService: { handleRatingReply: jest.Mock };

    beforeEach(async () => {
      prisma = { operator: { findUnique: jest.fn() }, rescueRequest: { findUnique: jest.fn() } };
      customerFlowService = { handleRatingReply: jest.fn().mockResolvedValue('rated') };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppOperatorFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
          { provide: WhatsAppSessionStore, useValue: {} },
        ],
      }).compile();

      orderingService = module.get<WhatsAppOperatorFlowService>(WhatsAppOperatorFlowService);
    });

    it('routes a WAITING_FOR_RATING operator reply to the rating handler, not the quote parser', async () => {
      const session = { state: WhatsAppFlowState.WAITING_FOR_RATING, rescueRequestId: 'req-1' } as any;
      const operator = { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111' };

      const result = await orderingService.handleOperatorMessage('+2341111111111', 'op-user-1', '4', session, operator);

      // handleOperatorQuoteOrDecline's quote path always starts with an
      // operator.findUnique lookup — asserting it was never called proves
      // the numeric reply was routed to the rating handler instead, not
      // treated as a bogus price quote.
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(customerFlowService.handleRatingReply).toHaveBeenCalledWith(
        'op-user-1', '4', 'req-1', 'OPERATOR_TO_MOTORIST',
      );
      expect(result).toBe('rated');
    });
  });

  describe('handleOperatorQuoteOrDecline — concurrent-offer disambiguation', () => {
    let quoteService: WhatsAppOperatorFlowService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };
    let dispatchService: { processQuoteOrDecline: jest.Mock };

    const offerA = { id: 'offer-a', rescueRequestId: 'req-aaaaaaAAAAAA', expiresAt: new Date() };
    const offerB = { id: 'offer-b', rescueRequestId: 'req-bbbbbbBBBBBB', expiresAt: new Date() };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn().mockResolvedValue({ id: 'op-1' }) },
        dispatchOffer: { findMany: jest.fn() },
      };
      dispatchService = {
        processQuoteOrDecline: jest.fn().mockResolvedValue({ quoted: true, message: 'ok' }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppOperatorFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: DispatchService, useValue: dispatchService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppCustomerFlowService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
        ],
      }).compile();

      quoteService = module.get<WhatsAppOperatorFlowService>(WhatsAppOperatorFlowService);
    });

    it('uses the single pending offer when a bare price is given (unchanged, common case)', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect(dispatchService.processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('asks the operator to disambiguate instead of guessing when multiple offers are pending and no ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect(dispatchService.processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain('AAAAAA');
      expect(result).toContain('BBBBBB');
    });

    it('matches the correct offer when a job ref is given', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'AAAAAA');

      expect(dispatchService.processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('rejects a job ref that matches none of the pending offers', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000, 'ZZZZZZ');

      expect(dispatchService.processQuoteOrDecline).not.toHaveBeenCalled();
      expect(result).toContain("doesn't match");
    });
  });
});
