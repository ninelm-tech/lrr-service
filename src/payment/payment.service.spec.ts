import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';
import { RescueRequestService } from '../rescue-request/rescue-request.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PayoutService } from '../payout/payout.service';

describe('PaymentService', () => {
  let service: PaymentService;
  let rescueRequestService: {
    handleDepositPaymentConfirmed: jest.Mock;
    handleBalancePaymentConfirmed: jest.Mock;
  };
  let subscriptionService: {
    handleSubscriptionInitCharge: jest.Mock;
    handleInvoicePaymentSuccess: jest.Mock;
    handleSubscriptionExpired: jest.Mock;
    handleSubscriptionCreate: jest.Mock;
  };
  let payoutService: { confirmTransferOutcome: jest.Mock };

  beforeEach(async () => {
    rescueRequestService = {
      handleDepositPaymentConfirmed: jest.fn(),
      handleBalancePaymentConfirmed: jest.fn(),
    };
    subscriptionService = {
      handleSubscriptionInitCharge: jest.fn(),
      handleInvoicePaymentSuccess: jest.fn(),
      handleSubscriptionExpired: jest.fn(),
      handleSubscriptionCreate: jest.fn(),
    };
    payoutService = { confirmTransferOutcome: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: RescueRequestService, useValue: rescueRequestService },
        { provide: SubscriptionService, useValue: subscriptionService },
        { provide: PayoutService, useValue: payoutService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handlePaystackWebhook — transfer events', () => {
    it('confirms SUCCESS on transfer.success', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.success',
        data: { transfer_code: 'TRF_test123', reason: 'Job payout' },
      });

      expect(payoutService.confirmTransferOutcome).toHaveBeenCalledWith('TRF_test123', 'SUCCESS');
    });

    it('confirms FAILED with the reason on transfer.failed', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.failed',
        data: { transfer_code: 'TRF_test123', reason: 'Invalid account number' },
      });

      expect(payoutService.confirmTransferOutcome).toHaveBeenCalledWith('TRF_test123', 'FAILED', 'Invalid account number');
    });

    it('confirms FAILED on transfer.reversed', async () => {
      await service.handlePaystackWebhook({
        event: 'transfer.reversed',
        data: { transfer_code: 'TRF_test123', reason: 'Reversed by bank' },
      });

      expect(payoutService.confirmTransferOutcome).toHaveBeenCalledWith('TRF_test123', 'FAILED', 'Reversed by bank');
    });
  });
});
