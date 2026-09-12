import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { DispatchService } from './dispatch.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { PlatformConfigService } from '../platform-config/platform-config.service';

describe('WhatsAppOperatorFlowService', () => {
  describe('handleOperatorMessage — rating branch ordering', () => {
    let orderingService: WhatsAppOperatorFlowService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };
    let customerFlowService: { handleRatingReply: jest.Mock };

    beforeEach(async () => {
      prisma = {
        operator: { findUnique: jest.fn() },
        rescueRequest: { findUnique: jest.fn() },
        dispatchOffer: { findMany: jest.fn().mockResolvedValue([]) },
      };
      customerFlowService = { handleRatingReply: jest.fn().mockResolvedValue('rated') };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppOperatorFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          {
            provide: DispatchService,
            useValue: { processQuoteOrDecline: jest.fn().mockResolvedValue({ message: 'declined' }) },
          },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
        ],
      }).compile();

      orderingService = module.get<WhatsAppOperatorFlowService>(WhatsAppOperatorFlowService);
    });

    it('routes a WAITING_FOR_RATING operator reply to the rating handler, not the quote parser', async () => {
      const session = { state: WhatsAppFlowState.WAITING_FOR_RATING, rescueRequestId: 'req-1' } as any;
      const operator = { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111' };

      const result = await orderingService.handleOperatorMessage('+2341111111111', 'op-user-1', '4', '4', session, operator);

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

    it('routes a WAITING_FOR_RATING operator reply to the new-offer decline instead, when an offer is open', async () => {
      const session = { state: WhatsAppFlowState.WAITING_FOR_RATING, rescueRequestId: 'req-1' } as any;
      const operator = { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111' };
      prisma.dispatchOffer.findMany.mockResolvedValue([
        { rescueRequestId: 'req-2', rescueRequest: { vehicleType: 'SEDAN', destination: 'Ikeja' } },
      ]);
      prisma.operator.findUnique.mockResolvedValue(operator);

      await orderingService.handleOperatorMessage('+2341111111111', 'op-user-1', 'no', 'no', session, operator);

      // A stale rating prompt must not swallow a decline for a genuinely
      // open dispatch offer — the rating handler must not fire at all.
      expect(customerFlowService.handleRatingReply).not.toHaveBeenCalled();
      expect(prisma.operator.findUnique).toHaveBeenCalled();
    });
  });

  describe('handleOperatorQuoteOrDecline — concurrent-offer disambiguation', () => {
    let quoteService: WhatsAppOperatorFlowService;
    let prisma: {
      operator: { findUnique: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };
    let dispatchService: { processQuoteOrDecline: jest.Mock };

    const offerA = {
      id: 'offer-a', rescueRequestId: 'req-aaaaaaAAAAAA', expiresAt: new Date(),
      rescueRequest: { vehicleType: 'SEDAN', destination: 'Ikeja under bridge' },
    };
    const offerB = {
      id: 'offer-b', rescueRequestId: 'req-bbbbbbBBBBBB', expiresAt: new Date(),
      rescueRequest: { vehicleType: 'SUV', destination: 'Lekki Phase 1' },
    };

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
          { provide: PlatformConfigService, useValue: {} },
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

    it('describes each open job by vehicle and destination — a bare ref means nothing to an operator', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      expect(result).toContain('Ikeja under bridge');
      expect(result).toContain('Lekki Phase 1');
      // Refs are printed bare, matching the "AAAAAA 25000" example the same
      // message gives — printing "Job #AAAAAA" is what led operators to reply
      // with the # still attached.
      expect(result).not.toContain('Job #');
    });

    it('only filters to offers that have not already expired', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerA]);

      await (quoteService as any).handleOperatorQuoteOrDecline('+2341', 'user-1', 2500000);

      const where = prisma.dispatchOffer.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PENDING');
      expect(where.expiresAt.gt).toBeInstanceOf(Date);
    });

    it('answers a bare job ref with that job\'s details and asks for the price, rather than staying silent', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await quoteService.handleOperatorMessage(
        '+2341', 'user-1', '#AAAAAA', '#AAAAAA',
        { state: WhatsAppFlowState.IDLE } as any,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341' },
      );

      expect(result).toContain('Ikeja under bridge');
      expect(result).toContain('AAAAAA 25000');
      expect(dispatchService.processQuoteOrDecline).not.toHaveBeenCalled();
    });

    it('accepts a job ref with the leading # the offer message itself displays', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      await quoteService.handleOperatorMessage(
        '+2341', 'user-1', '#AAAAAA 25000', '#AAAAAA 25000',
        { state: WhatsAppFlowState.IDLE } as any,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341' },
      );

      expect(dispatchService.processQuoteOrDecline).toHaveBeenCalledWith(offerA, 2500000);
    });

    it('does not mistake a six-letter command for a job reference', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([offerB, offerA]);

      const result = await quoteService.handleOperatorMessage(
        '+2341', 'user-1', 'onsite', 'onsite',
        { state: WhatsAppFlowState.IDLE } as any,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341' },
      );

      // No open offer ends in "ONSITE", so it falls through to the ARRIVED
      // branch, which correctly rejects it for lack of an active job.
      expect(result).toContain("don't have an active job");
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

  describe('AWAITING_DISPUTE_RESPONSE', () => {
    let service: WhatsAppOperatorFlowService;
    let prisma: { rescueRequest: { update: jest.Mock } };
    let sessionStore: { update: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { update: jest.fn() } };
      sessionStore = { update: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppOperatorFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppCustomerFlowService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PlatformConfigService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppOperatorFlowService>(WhatsAppOperatorFlowService);
    });

    it('captures the operator\'s raw statement, reverts session state, and acknowledges', async () => {
      const session = { state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE, rescueRequestId: 'req-1' } as any;

      await service.handleOperatorMessage(
        '+2348011112222', 'op-user-1', 'the customer wasnt there when i arrived',
        'The customer wasn\'t there when I arrived.', session,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2348011112222' },
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { operatorDisputeStatement: 'The customer wasn\'t there when I arrived.' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', { state: WhatsAppFlowState.OPERATOR_AT_LOCATION });
    });
  });

  describe('masked chat relay', () => {
    let service: WhatsAppOperatorFlowService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    const operatorPhone = '+2348011112222';
    const customerPhone = '+2348012345678';

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn() };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WhatsAppOperatorFlowService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: twilioService },
          { provide: DispatchService, useValue: {} },
          { provide: PaymentEventsService, useValue: {} },
          { provide: WhatsAppCustomerFlowService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PlatformConfigService, useValue: {} },
        ],
      }).compile();

      service = module.get<WhatsAppOperatorFlowService>(WhatsAppOperatorFlowService);
    });

    it('relays a plain message to the customer while relayTarget is set', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', customer: { phoneNumber: customerPhone },
      });
      const session = { state: WhatsAppFlowState.OPERATOR_AT_LOCATION, rescueRequestId: 'req-1', relayTarget: 'CUSTOMER' } as any;

      await service.handleOperatorMessage(
        operatorPhone, 'op-user-1', 'on my way', 'On my way, 5 minutes.', session,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: operatorPhone },
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        'Driver: On my way, 5 minutes.',
      );
    });

    it('END CHAT clears relayTarget on both sides and notifies both', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', customer: { phoneNumber: customerPhone },
      });
      const session = { state: WhatsAppFlowState.OPERATOR_AT_LOCATION, rescueRequestId: 'req-1', relayTarget: 'CUSTOMER' } as any;

      await service.handleOperatorMessage(
        operatorPhone, 'op-user-1', 'end chat', 'end chat', session,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: operatorPhone },
      );

      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', { relayTarget: null });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', { relayTarget: null });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(expect.stringContaining(operatorPhone), 'Chat ended.');
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(expect.stringContaining(customerPhone), 'Chat ended.');
    });

    it('does not treat a numeric quote-shaped reply as a command while relaying', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', customerId: 'cust-1', customer: { phoneNumber: customerPhone },
      });
      const session = { state: WhatsAppFlowState.OPERATOR_AT_LOCATION, rescueRequestId: 'req-1', relayTarget: 'CUSTOMER' } as any;

      await service.handleOperatorMessage(
        operatorPhone, 'op-user-1', '50000', '50000', session,
        { id: 'op-1', businessName: 'Swift Towing', phoneNumber: operatorPhone },
      );

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        'Driver: 50000',
      );
    });
  });
});
