import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PayoutModule } from '../payout/payout.module';

@Module({
  imports: [
    PaystackModule,
    forwardRef(() => RescueRequestModule),
    PayoutModule,
  ],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
