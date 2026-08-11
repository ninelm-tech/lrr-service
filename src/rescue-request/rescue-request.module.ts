import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaModule } from '../prisma/prisma.module';
import { RescueRequestController } from './rescue-request.controller';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { S3Module } from '../integrations/s3/s3.module';
import { OperatorModule } from '../operator/operator.module';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { RatingModule } from '../rating/rating.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    PaystackModule,
    TwilioModule,
    S3Module,
    OperatorModule,
    PlatformConfigModule,
    RatingModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [RescueRequestController],
  providers: [RescueRequestService, WhatsAppSessionStore, AuthGuard],
  exports: [RescueRequestService],
})
export class RescueRequestModule {}
