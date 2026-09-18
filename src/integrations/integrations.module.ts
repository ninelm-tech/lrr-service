import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { PaystackModule } from './paystack/paystack.module';
import { S3Module } from './s3/s3.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { TermiiModule } from './termii/termii.module';

@Module({
  imports: [TwilioModule, PaystackModule, S3Module, GeocodingModule, TermiiModule],
  exports: [GeocodingModule],
})
export class IntegrationsModule {}
