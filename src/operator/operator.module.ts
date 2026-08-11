import { Module } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { OperatorController } from './operator.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PaystackModule } from '../integrations/paystack/paystack.module';

@Module({
  imports: [PrismaModule, AuthModule, PaystackModule],
  providers: [OperatorService],
  controllers: [OperatorController],
  exports: [OperatorService],
})
export class OperatorModule {}
