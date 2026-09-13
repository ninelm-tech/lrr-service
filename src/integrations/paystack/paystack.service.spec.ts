import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaystackService } from './paystack.service';

describe('PaystackService', () => {
  let service: PaystackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaystackService,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    service = module.get<PaystackService>(PaystackService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveAccountNumber', () => {
    it('returns the resolved account name from Paystack', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: true,
          data: { account_name: 'JOHN DOE', account_number: '0123456789' },
        }),
      });
      global.fetch = fetchMock as any;

      const result = await service.resolveAccountNumber('0123456789', '058');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );
      expect(result).toEqual({ accountName: 'JOHN DOE' });
    });

    it('throws a BadRequestException instead of crashing on unresolvable/invalid accounts', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: false,
          message: 'Invalid account number',
        }),
      });
      global.fetch = fetchMock as any;

      await expect(service.resolveAccountNumber('123', '058')).rejects.toThrow(
        'Invalid account number',
      );
    });
  });

  describe('createTransferRecipient', () => {
    it('creates a recipient and returns the recipient code', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: true,
          data: { recipient_code: 'RCP_test123' },
        }),
      });
      global.fetch = fetchMock as any;

      const result = await service.createTransferRecipient({
        accountNumber: '0123456789',
        bankCode: '058',
        accountName: 'JOHN DOE',
        businessName: 'Swift Towing',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/transferrecipient',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            type: 'nuban',
            name: 'Swift Towing',
            account_number: '0123456789',
            bank_code: '058',
            currency: 'NGN',
          }),
        }),
      );
      expect(result).toEqual({ recipientCode: 'RCP_test123' });
    });
  });

  describe('checkBalance', () => {
    it('returns the available NGN balance in kobo', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: true,
          data: [{ currency: 'NGN', balance: 500000 }],
        }),
      });
      global.fetch = fetchMock as any;

      const result = await service.checkBalance();

      expect(result).toBe(500000);
    });
  });

  describe('initiateTransfer', () => {
    it('initiates a transfer and returns the transfer code and status', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: true,
          data: { transfer_code: 'TRF_test123', status: 'pending' },
        }),
      });
      global.fetch = fetchMock as any;

      const result = await service.initiateTransfer({
        recipientCode: 'RCP_test123',
        amount: 250000,
        reference: 'PAYOUT_123',
        reason: 'Job payout',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/transfer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            source: 'balance',
            amount: 250000,
            recipient: 'RCP_test123',
            reference: 'PAYOUT_123',
            reason: 'Job payout',
          }),
        }),
      );
      expect(result).toEqual({
        outcome: 'ok',
        data: { transfer_code: 'TRF_test123', status: 'pending' },
      });
    });

    it('classifies a 5xx as ambiguous — the transfer may still have landed', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 502,
        json: async () => ({ status: false, message: 'Bad gateway' }),
      }) as any;

      expect(
        await service.initiateTransfer({
          recipientCode: 'RCP_test123',
          amount: 250000,
          reference: 'payout_1',
          reason: 'Job payout',
        }),
      ).toEqual({ outcome: 'ambiguous', message: 'Bad gateway' });
    });

    it('classifies a thrown network error as ambiguous, never a rejection', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNRESET')) as any;

      expect(
        await service.initiateTransfer({
          recipientCode: 'RCP_test123',
          amount: 250000,
          reference: 'payout_1',
          reason: 'Job payout',
        }),
      ).toEqual({ outcome: 'ambiguous', message: 'ECONNRESET' });
    });

    it('classifies a 4xx with a provider code as a definitive rejection', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 400,
        json: async () => ({
          status: false,
          code: 'invalid_recipient',
          message: 'Recipient is invalid',
        }),
      }) as any;

      expect(
        await service.initiateTransfer({
          recipientCode: 'RCP_bad',
          amount: 250000,
          reference: 'payout_1',
          reason: 'Job payout',
        }),
      ).toEqual({
        outcome: 'rejected',
        code: 'invalid_recipient',
        message: 'Recipient is invalid',
      });
    });
  });

  describe('listBanks', () => {
    it('returns the bank list and caches it for subsequent calls', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({
          status: true,
          data: [
            { name: 'GTBank', code: '058' },
            { name: 'Access Bank', code: '044' },
          ],
        }),
      });
      global.fetch = fetchMock as any;

      const first = await service.listBanks();
      const second = await service.listBanks();

      expect(first).toEqual([
        { name: 'GTBank', code: '058' },
        { name: 'Access Bank', code: '044' },
      ]);
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1); // cached, not re-fetched
    });
  });

  describe('refundTransaction', () => {
    /**
     * Typed rather than `as any`: the classification under test branches on
     * `response.status`, and an untyped stub silently allows a mock that
     * omits it — which would make every one of these tests pass for the
     * wrong reason.
     */
    const stubFetch = (status: number, body: unknown) => {
      const fn = jest
        .fn()
        .mockResolvedValue({ status, json: () => Promise.resolve(body) });
      global.fetch = fn;
      return fn;
    };

    const refund = () =>
      service.refundTransaction({
        transaction: 'DEP_ref_1',
        amount: 500000,
        merchantNote: 'pay-abc',
      });

    it('POSTs the merchant_note — the only identifier of ours a refund carries', async () => {
      const mockFetch = stubFetch(200, {
        status: true,
        data: { id: 12345, status: 'pending' },
      });

      const result = await refund();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.paystack.co/refund',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            transaction: 'DEP_ref_1',
            amount: 500000,
            merchant_note: 'pay-abc',
          }),
        }),
      );
      expect(result).toEqual({
        outcome: 'ok',
        data: { id: 12345, status: 'pending' },
      });
    });

    it('classifies a thrown network error as ambiguous — a retry would refund twice', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));

      expect(await refund()).toEqual({
        outcome: 'ambiguous',
        message: 'socket hang up',
      });
    });

    it('classifies a 5xx as ambiguous', async () => {
      stubFetch(503, { status: false, message: 'Service unavailable' });

      expect(await refund()).toEqual({
        outcome: 'ambiguous',
        message: 'Service unavailable',
      });
    });

    it('classifies a 4xx with a provider code as a definitive rejection', async () => {
      stubFetch(400, {
        status: false,
        code: 'transaction_not_found',
        message: 'Transaction not found',
      });

      expect(await refund()).toEqual({
        outcome: 'rejected',
        code: 'transaction_not_found',
        message: 'Transaction not found',
      });
    });
  });
});
