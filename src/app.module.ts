import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IntegrationsModule } from './integrations/integrations.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RescueRequestModule } from './rescue-request/rescue-request.module';
import { PaymentModule } from './payment/payment.module';
import { OperatorModule } from './operator/operator.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    IntegrationsModule,
    PrismaModule,
    AuthModule,
    RescueRequestModule,
    PaymentModule,
    OperatorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}