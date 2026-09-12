import { Module } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { OperatorController } from './operator.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { OtpModule } from '../otp/otp.module';

@Module({
  imports: [PrismaModule, AuthModule, PaystackModule, OtpModule],
  providers: [OperatorService],
  controllers: [OperatorController],
  exports: [OperatorService],
})
export class OperatorModule {}
