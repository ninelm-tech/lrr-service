import { Test, TestingModule } from '@nestjs/testing';
import { PaystackController } from './paystack.controller';

describe('PaystackController', () => {
  let controller: PaystackController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaystackController],
    }).compile();

    controller = module.get<PaystackController>(PaystackController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
