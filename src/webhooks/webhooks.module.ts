import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [RescueRequestModule, PaymentModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
