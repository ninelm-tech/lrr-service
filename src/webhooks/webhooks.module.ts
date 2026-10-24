import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PaymentModule } from '../payment/payment.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';

@Module({
  imports: [RescueRequestModule, PaymentModule, TwilioModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
