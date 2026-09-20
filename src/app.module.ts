import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
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
import { MediaModule } from './media/media.module';
import { PlatformConfigModule } from './platform-config/platform-config.module';
import { RatingModule } from './rating/rating.module';
import { OtpModule } from './otp/otp.module';
import { AccountDeletionModule } from './account-deletion/account-deletion.module';

@Module({
  imports: [
    // Must be first — Sentry's own recommended module ordering, so it can
    // wrap everything registered after it.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // ThrottlerModule's storage/tracker infrastructure (a @Global()
    // registration, per @nestjs/throttler) is registered in OtpModule, not
    // here — see the comment there for why. Nothing is throttled by default;
    // OtpModule and AuthModule apply ThrottlerGuard locally to their two
    // SMS-triggering routes only.
    IntegrationsModule,
    PrismaModule,
    AuthModule,
    RescueRequestModule,
    PaymentModule,
    OperatorModule,
    WebhooksModule,
    MediaModule,
    PlatformConfigModule,
    RatingModule,
    OtpModule,
    AccountDeletionModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Auto-capture every unhandled HTTP exception into Sentry — Sentry's own
    // maintained mechanism (docs.sentry.io/platforms/node/guides/nestjs),
    // replacing the old hand-rolled interceptor. Same scope as before (HTTP
    // routes only — background/reconciler code still needs its own explicit
    // Sentry.captureException calls, which already exist there).
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class AppModule {}
