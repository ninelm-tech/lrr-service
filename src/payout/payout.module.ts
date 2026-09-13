import { Module, forwardRef } from '@nestjs/common';
import { PayoutService } from './payout.service';
import { PayoutController } from './payout.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { AuthModule } from '../auth/auth.module';
// forwardRef both ways: PaymentModule already imports this module, and
// payouts now go through PaymentLedgerService.
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [
    forwardRef(() => PaymentModule),
    PrismaModule,
    PaystackModule,
    TwilioModule,
    AuthModule,
  ],
  controllers: [PayoutController],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}
