import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IntegrationsModule } from './integrations/integrations.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RescueRequestModule } from './rescue-request/rescue-request.module';
import { PaymentModule } from './payment/payment.module';
import { OperatorModule } from './operator/operator.module';
import { AuthModule } from './auth/auth.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { MediaModule } from './media/media.module';
import { SentryInterceptor } from './common/sentry.interceptor';

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
    WebhooksModule,
    SubscriptionModule,
    MediaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Auto-capture every unhandled 5xx exception into Sentry
    { provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
  ],
})
export class AppModule {}
