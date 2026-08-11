import { Module } from '@nestjs/common';
import { PayoutService } from './payout.service';
import { PayoutController } from './payout.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, PaystackModule, AuthModule],
  controllers: [PayoutController],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}
