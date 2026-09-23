import { Test, TestingModule } from '@nestjs/testing';
import { PaymentAdminController } from './payment-admin.controller';
import { PaymentAdminService } from './payment-admin.service';
import { AuthGuard } from '../auth/auth.guard';

describe('PaymentAdminController', () => {
  let controller: PaymentAdminController;
  let paymentAdminService: {
    listForUser: jest.Mock;
    summaryForUser: jest.Mock;
  };

  beforeEach(async () => {
    paymentAdminService = {
      listForUser: jest.fn(),
      summaryForUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentAdminController],
      providers: [
        { provide: PaymentAdminService, useValue: paymentAdminService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PaymentAdminController>(PaymentAdminController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('list', () => {
    it('forwards the authenticated user and query to the service', async () => {
      const response = { data: [], meta: { page: 1, limit: 20, total: 0 } };
      paymentAdminService.listForUser.mockResolvedValue(response);
      const req = { user: { userId: 'admin-1', role: 'SUPER_ADMIN' } } as any;

      const result = await controller.list(req, { type: 'DEPOSIT' } as any);

      expect(paymentAdminService.listForUser).toHaveBeenCalledWith(req.user, {
        type: 'DEPOSIT',
      });
      expect(result).toBe(response);
    });
  });

  describe('summary', () => {
    it('forwards the authenticated user and query to the service', async () => {
      const response = {
        depositCollected: 0,
        balanceCollected: 0,
        totalCollected: 0,
        depositPending: 0,
        balancePending: 0,
        totalOutstanding: 0,
      };
      paymentAdminService.summaryForUser.mockResolvedValue(response);
      const req = { user: { userId: 'admin-1', role: 'SUPER_ADMIN' } } as any;

      const result = await controller.summary(req, {});

      expect(paymentAdminService.summaryForUser).toHaveBeenCalledWith(
        req.user,
        {},
      );
      expect(result).toBe(response);
    });
  });
});
