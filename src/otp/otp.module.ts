import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { OtpService } from './otp.service';
import { OtpController } from './otp.controller';
import { TermiiModule } from '../integrations/termii/termii.module';
import {
  SMS_TRIGGER_THROTTLE_LIMIT,
  SMS_TRIGGER_THROTTLE_TTL_MS,
} from '../common/sms-throttle.constants';

@Module({
  imports: [
    TermiiModule,
    // ThrottlerModule is @Global() (per @nestjs/throttler), so registering
    // it once here makes its storage/tracker infrastructure available to
    // any module in the same graph — including AuthModule, which imports
    // OtpModule and applies its own local ThrottlerGuard to
    // AuthController.sendLoginCode. Registered here rather than in
    // AppModule so OtpModule (and anything that transitively depends on it,
    // e.g. AuthModule/PayoutModule in their module-level DI smoke tests)
    // stays resolvable on its own, without requiring the full AppModule
    // graph. NOT bound as a global guard — nothing is throttled app-wide by
    // this; see common/sms-throttle.constants.ts for what it protects.
    ThrottlerModule.forRoot([
      { ttl: SMS_TRIGGER_THROTTLE_TTL_MS, limit: SMS_TRIGGER_THROTTLE_LIMIT },
    ]),
  ],
  // ThrottlerGuard is applied locally (see OtpController.sendCode) rather
  // than as a global guard — it must be a provider here for DI to resolve
  // it.
  providers: [OtpService, ThrottlerGuard],
  controllers: [OtpController],
  exports: [OtpService],
})
export class OtpModule {}
