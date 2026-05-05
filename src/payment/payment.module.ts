import { Module, forwardRef } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';

@Module({
  imports: [PaystackModule, forwardRef(() => RescueRequestModule)],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
