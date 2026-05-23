import { Test, TestingModule } from '@nestjs/testing';
import { PaystackService } from './paystack.service';

// Note: Paystack has no dedicated controller — webhooks route through WebhooksModule.
// This spec validates the service can be instantiated.
describe('PaystackService', () => {
  let service: PaystackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PaystackService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<PaystackService>(PaystackService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
