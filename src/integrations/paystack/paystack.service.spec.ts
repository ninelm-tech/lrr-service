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
        json: async () => ({ status: true, data: { account_name: 'JOHN DOE', account_number: '0123456789' } }),
      });
      global.fetch = fetchMock as any;

      const result = await service.resolveAccountNumber('0123456789', '058');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.any(String) }) }),
      );
      expect(result).toEqual({ accountName: 'JOHN DOE' });
    });
  });

  describe('createTransferRecipient', () => {
    it('creates a recipient and returns the recipient code', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({ status: true, data: { recipient_code: 'RCP_test123' } }),
      });
      global.fetch = fetchMock as any;

      const result = await service.createTransferRecipient({
        accountNumber: '0123456789', bankCode: '058', accountName: 'JOHN DOE', businessName: 'Swift Towing',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/transferrecipient',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            type: 'nuban', name: 'Swift Towing', account_number: '0123456789', bank_code: '058', currency: 'NGN',
          }),
        }),
      );
      expect(result).toEqual({ recipientCode: 'RCP_test123' });
    });
  });

  describe('checkBalance', () => {
    it('returns the available NGN balance in kobo', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({ status: true, data: [{ currency: 'NGN', balance: 500000 }] }),
      });
      global.fetch = fetchMock as any;

      const result = await service.checkBalance();

      expect(result).toBe(500000);
    });
  });

  describe('initiateTransfer', () => {
    it('initiates a transfer and returns the transfer code and status', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({ status: true, data: { transfer_code: 'TRF_test123', status: 'pending' } }),
      });
      global.fetch = fetchMock as any;

      const result = await service.initiateTransfer({
        recipientCode: 'RCP_test123', amount: 250000, reference: 'PAYOUT_123', reason: 'Job payout',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.paystack.co/transfer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            source: 'balance', amount: 250000, recipient: 'RCP_test123', reference: 'PAYOUT_123', reason: 'Job payout',
          }),
        }),
      );
      expect(result).toEqual({ transferCode: 'TRF_test123', status: 'pending' });
    });
  });

  describe('listBanks', () => {
    it('returns the bank list and caches it for subsequent calls', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        json: async () => ({ status: true, data: [{ name: 'GTBank', code: '058' }, { name: 'Access Bank', code: '044' }] }),
      });
      global.fetch = fetchMock as any;

      const first = await service.listBanks();
      const second = await service.listBanks();

      expect(first).toEqual([{ name: 'GTBank', code: '058' }, { name: 'Access Bank', code: '044' }]);
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1); // cached, not re-fetched
    });
  });
});
