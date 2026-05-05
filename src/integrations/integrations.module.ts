import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { PaystackModule } from './paystack/paystack.module';

@Module({
  imports: [TwilioModule, PaystackModule]
})
export class IntegrationsModule {}
