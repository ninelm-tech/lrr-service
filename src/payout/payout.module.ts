import { Module } from '@nestjs/common';
import { PayoutService } from './payout.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaystackModule } from '../integrations/paystack/paystack.module';

@Module({
  imports: [PrismaModule, PaystackModule],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}
