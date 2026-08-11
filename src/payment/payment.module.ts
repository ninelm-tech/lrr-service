import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { PayoutModule } from '../payout/payout.module';

@Module({
  imports: [
    PaystackModule,
    forwardRef(() => RescueRequestModule),
    forwardRef(() => SubscriptionModule),
    PayoutModule,
  ],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
