import { Test, TestingModule } from '@nestjs/testing';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: {
    payout: { create: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
    operator: { findUnique: jest.Mock };
  };
  let paystack: {
    checkBalance: jest.Mock;
    initiateTransfer: jest.Mock;
    generateReference: jest.Mock;
  };
  let twilio: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
  const originalTemplateSids = {
    sent: process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID,
    bank: process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID,
  };

  afterEach(() => {
    for (const [key, value] of [
      ['TWILIO_PAYOUT_SENT_TEMPLATE_SID', originalTemplateSids.sent],
      ['TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID', originalTemplateSids.bank],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    prisma = {
      payout: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      operator: { findUnique: jest.fn() },
    };
    paystack = {
      checkBalance: jest.fn(),
      initiateTransfer: jest.fn(),
      generateReference: jest.fn().mockReturnValue('PAYOUT_test123'),
    };
    twilio = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };
    delete process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID;
    delete process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystack },
        { provide: TwilioService, useValue: twilio },
      ],
    }).compile();

    service = module.get<PayoutService>(PayoutService);
  });

  describe('createAndProcessPayout', () => {
    it('blocks with NO_BANK_DETAILS when the operator has no recipient code, and tells the operator', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: null, businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.payout.updateMany.mockResolvedValue({ count: 1 }); // newly blocked

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.create).toHaveBeenCalledWith({
        data: { rescueRequestId: 'req-1', operatorId: 'op-1', amount: 250000 },
      });
      // Conditional write on blockReason alone — see the invariant note in
      // payout.service.ts; matching on status too would re-notify on retry.
      //
      // The `blockReason: null` branch is asserted deliberately. blockReason
      // is nullable and a fresh payout starts NULL; a bare `NOT` filter is
      // UNKNOWN for NULL and would match nothing, silently breaking the
      // first block of EVERY payout. NB: this mock never evaluates the where
      // clause, so this asserts its shape only — real NULL matching
      // semantics would need an integration test against Postgres.
      expect(prisma.payout.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'payout-1',
          OR: [
            { blockReason: null },
            { blockReason: { not: 'NO_BANK_DETAILS' } },
          ],
        },
        data: { status: 'PENDING', blockReason: 'NO_BANK_DETAILS', failureReason: null },
      });
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        expect.stringContaining("don't have your bank details"),
      );
      expect(paystack.checkBalance).not.toHaveBeenCalled();
    });

    it('does not notify, but still restores PENDING, when the payout was already blocked for the same reason', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: null, businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.payout.updateMany.mockResolvedValue({ count: 0 }); // already NO_BANK_DETAILS

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      // Must not strand the row at PROCESSING when a retry claimed it.
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', failureReason: null },
      });
    });

    it('sends the bank-details notice via the approved template when its SID is configured', async () => {
      process.env.TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID = 'HXbank123';
      process.env.FRONTEND_URL = 'https://portal.example.com';
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: null, phoneNumber: '+2349012345678',
      });
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        'HXbank123',
        { '1': expect.any(String), '2': '2,500', '3': 'https://portal.example.com/settings' },
      );
      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a failed notification never breaks the payout flow', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: null, phoneNumber: '+2349012345678',
      });
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      twilio.sendWhatsAppMessage.mockRejectedValue(new Error('63016: outside messaging window'));

      await expect(service.createAndProcessPayout('req-1', 'op-1', 250000)).resolves.not.toThrow();
    });

    it('blocks with INSUFFICIENT_BALANCE when the platform balance cannot cover the amount', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(100000);

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', blockReason: 'INSUFFICIENT_BALANCE', failureReason: null },
      });
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('initiates a transfer and sets PROCESSING on success', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockResolvedValue({ transferCode: 'TRF_test123', status: 'pending' });

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(paystack.initiateTransfer).toHaveBeenCalledWith({
        recipientCode: 'RCP_existing', amount: 250000, reference: 'PAYOUT_test123', reason: 'Job payout — req-1',
      });
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PROCESSING', blockReason: null, paystackTransferCode: 'TRF_test123' },
      });
    });

    it('marks FAILED when the transfer API call throws', async () => {
      prisma.payout.create.mockResolvedValue({ id: 'payout-1' });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', paystackRecipientCode: 'RCP_existing', businessName: 'Swift Towing',
      });
      paystack.checkBalance.mockResolvedValue(1000000);
      paystack.initiateTransfer.mockRejectedValue(new Error('Paystack 500'));

      await service.createAndProcessPayout('req-1', 'op-1', 250000);

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'FAILED', blockReason: null, failureReason: 'Paystack 500' },
      });
    });

    it('never throws back to the caller even on an unexpected error', async () => {
      prisma.payout.create.mockRejectedValue(new Error('DB unavailable'));

      await expect(service.createAndProcessPayout('req-1', 'op-1', 250000)).resolves.not.toThrow();
    });
  });

  describe('retryPayout', () => {
    const retryablePayout = (status: string) => ({
      id: 'payout-1', operatorId: 'op-1', amount: 250000, rescueRequestId: 'req-1', status,
    });

    it('throws NotFoundException for an unknown payout', async () => {
      prisma.payout.findUnique.mockResolvedValue(null);

      await expect(service.retryPayout('nope')).rejects.toThrow('Payout not found');
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it.each(['SUCCESS', 'PROCESSING'])(
      'refuses to retry a %s payout — a second transfer would pay the operator twice',
      async (status) => {
        prisma.payout.findUnique.mockResolvedValue(retryablePayout(status));
        // No row matches the PENDING/FAILED claim condition.
        prisma.payout.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.retryPayout('payout-1')).rejects.toThrow(
          `Only blocked or failed payouts can be retried — this one is ${status}.`,
        );
        expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      },
    );

    it.each(['PENDING', 'FAILED'])('retries a %s payout', async (status) => {
      prisma.payout.findUnique.mockResolvedValue(retryablePayout(status));
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', paystackRecipientCode: 'RCP_x' });
      paystack.checkBalance.mockResolvedValue(1_000_000);
      paystack.initiateTransfer.mockResolvedValue({ transferCode: 'TRF_retry' });

      await service.retryPayout('payout-1');

      expect(prisma.payout.updateMany).toHaveBeenCalledWith({
        where: { id: 'payout-1', status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PROCESSING' },
      });
      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
    });

    it('returns the re-blocked state when the operator still has no bank details, rather than reporting success', async () => {
      prisma.payout.findUnique
        .mockResolvedValueOnce(retryablePayout('PENDING'))   // initial read
        .mockResolvedValueOnce({                              // state after the attempt
          ...retryablePayout('PENDING'), blockReason: 'NO_BANK_DETAILS',
        });
      // First updateMany is retryPayout's claim (1 row); the second is the
      // block attempt, which matches nothing because it's already blocked
      // for this reason.
      prisma.payout.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', paystackRecipientCode: null, phoneNumber: '+2349012345678' });

      const result = await service.retryPayout('payout-1');

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'PENDING', blockReason: 'NO_BANK_DETAILS' });
    });

    it('does NOT re-notify the operator when a retry re-blocks on the same missing bank details', async () => {
      prisma.payout.findUnique
        .mockResolvedValueOnce(retryablePayout('PENDING'))
        .mockResolvedValueOnce({ ...retryablePayout('PENDING'), blockReason: 'NO_BANK_DETAILS' });
      prisma.payout.updateMany
        .mockResolvedValueOnce({ count: 1 })  // claim
        .mockResolvedValueOnce({ count: 0 }); // already blocked for this reason
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', paystackRecipientCode: null, phoneNumber: '+2349012345678' });

      await service.retryPayout('payout-1');

      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
      // ...and the row goes back to PENDING rather than being stranded at
      // PROCESSING by the claim.
      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { id: 'payout-1' },
        data: { status: 'PENDING', failureReason: null },
      });
    });

    it('loses the race safely — the admin whose claim matches no row gets rejected, not a second transfer', async () => {
      // Status still reads PENDING (stale read), but a concurrent retry has
      // already claimed the row, so the conditional update matches nothing.
      prisma.payout.findUnique.mockResolvedValue(retryablePayout('PENDING'));
      prisma.payout.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.retryPayout('payout-1')).rejects.toThrow('Only blocked or failed payouts');
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });
  });

  describe('confirmTransferOutcome', () => {
    it('sets SUCCESS and completedAt when found, and tells the operator', async () => {
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.payout.findUnique.mockResolvedValue({
        id: 'payout-1', amount: 250000, rescueRequestId: 'req-1',
        operator: { phoneNumber: '+2349012345678' },
      });

      await service.confirmTransferOutcome('TRF_test123', 'SUCCESS');

      // Conditional write so a redelivered webhook can't double-message.
      expect(prisma.payout.updateMany).toHaveBeenCalledWith({
        where: { paystackTransferCode: 'TRF_test123', status: { not: 'SUCCESS' } },
        data: { status: 'SUCCESS', completedAt: expect.any(Date) },
      });
      expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        expect.stringContaining('₦2,500'),
      );
    });

    it('does not notify again when Paystack re-delivers an already-processed success webhook', async () => {
      prisma.payout.updateMany.mockResolvedValue({ count: 0 }); // already SUCCESS

      await service.confirmTransferOutcome('TRF_test123', 'SUCCESS');

      expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
      expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    });

    it('sends the paid notice via the approved template when its SID is configured', async () => {
      process.env.TWILIO_PAYOUT_SENT_TEMPLATE_SID = 'HXpaid123';
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.payout.findUnique.mockResolvedValue({
        id: 'payout-1', amount: 250000, rescueRequestId: 'req-1',
        operator: { phoneNumber: '+2349012345678' },
      });

      await service.confirmTransferOutcome('TRF_test123', 'SUCCESS');

      expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349012345678'),
        'HXpaid123',
        { '1': expect.any(String), '2': '2,500' },
      );
    });

    it('a failed paid-notification does not corrupt the payout row or throw', async () => {
      prisma.payout.updateMany.mockResolvedValue({ count: 1 });
      prisma.payout.findUnique.mockResolvedValue({
        id: 'payout-1', amount: 250000, rescueRequestId: 'req-1',
        operator: { phoneNumber: '+2349012345678' },
      });
      twilio.sendWhatsAppMessage.mockRejectedValue(new Error('63016'));

      await expect(service.confirmTransferOutcome('TRF_test123', 'SUCCESS')).resolves.not.toThrow();
    });

    it('sets FAILED with the given reason when found', async () => {
      prisma.payout.update.mockResolvedValue({});

      await service.confirmTransferOutcome('TRF_test123', 'FAILED', 'Invalid account');

      expect(prisma.payout.update).toHaveBeenCalledWith({
        where: { paystackTransferCode: 'TRF_test123' },
        data: { status: 'FAILED', failureReason: 'Invalid account' },
      });
    });

    it('does not throw when no matching payout is found', async () => {
      prisma.payout.update.mockRejectedValue(new Error('Record to update not found'));

      await expect(service.confirmTransferOutcome('TRF_unknown', 'SUCCESS')).resolves.not.toThrow();
    });
  });
});
