import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaystackCustomerService } from './paystack-customer.service';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PayoutModule } from '../payout/payout.module';

@Module({
  imports: [
    PaystackModule,
    forwardRef(() => RescueRequestModule),
    forwardRef(() => PayoutModule),
  ],
  providers: [PaymentService, PaymentLedgerService, PaystackCustomerService],
  // The ledger is exported because every money-moving flow — deposits,
  // balances, payouts, refunds — goes through it rather than writing its
  // own status transitions. PaystackCustomerService is exported for the same
  // reason: every collection flow resolves the customer through it rather
  // than building an email inline.
  exports: [PaymentService, PaymentLedgerService, PaystackCustomerService],
})
export class PaymentModule {}
