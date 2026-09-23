import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PaymentService } from './payment.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentAdminService } from './payment-admin.service';
import { PaymentAdminController } from './payment-admin.controller';
import { PaystackCustomerService } from './paystack-customer.service';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PayoutModule } from '../payout/payout.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { OperatorModule } from '../operator/operator.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PaystackModule,
    forwardRef(() => RescueRequestModule),
    forwardRef(() => PayoutModule),
    AuditLogModule,
    OperatorModule,
    // PaymentAdminController is the first controller/AuthGuard user in this
    // module — same local-JwtModule pattern as rescue-request.module.ts.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [PaymentAdminController],
  providers: [
    PaymentService,
    PaymentLedgerService,
    PaymentAdminService,
    PaystackCustomerService,
    AuthGuard,
  ],
  // The ledger is exported because every money-moving flow — deposits,
  // balances, payouts, refunds — goes through it rather than writing its
  // own status transitions. PaystackCustomerService is exported for the same
  // reason: every collection flow resolves the customer through it rather
  // than building an email inline.
  exports: [PaymentService, PaymentLedgerService, PaystackCustomerService],
})
export class PaymentModule {}
