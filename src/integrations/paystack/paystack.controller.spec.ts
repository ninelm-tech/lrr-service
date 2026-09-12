import { Test, TestingModule } from '@nestjs/testing';
import { PaystackController } from './paystack.controller';
import { PaystackService } from './paystack.service';

describe('PaystackController', () => {
  let controller: PaystackController;
  let paystackService: { listBanks: jest.Mock };

  beforeEach(async () => {
    paystackService = { listBanks: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaystackController],
      providers: [
        { provide: PaystackService, useValue: paystackService },
      ],
    }).compile();

    controller = module.get<PaystackController>(PaystackController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('listBanks', () => {
    it('returns the bank list from PaystackService', async () => {
      paystackService.listBanks.mockResolvedValue([{ name: 'GTBank', code: '058' }]);

      const result = await controller.listBanks();

      expect(result).toEqual({ data: [{ name: 'GTBank', code: '058' }] });
    });
  });
});
