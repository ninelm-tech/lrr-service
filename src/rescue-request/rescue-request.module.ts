import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DisputeService } from './dispute.service';
import { PaymentEventsService } from './payment-events.service';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { ReconcilerService } from './reconciler/reconciler.service';
import { RECONCILER_CHECKS } from './reconciler/reconciler-check.interface';
import { OfferSweepCheck } from './reconciler/checks/offer-sweep.check';
import { DepositExpiryCheck } from './reconciler/checks/deposit-expiry.check';
import { DepositReminderCheck } from './reconciler/checks/deposit-reminder.check';
import { BiddingCloseCheck } from './reconciler/checks/bidding-close.check';
import { BatchResolveCheck } from './reconciler/checks/batch-resolve.check';
import { QuoteSelectionTimeoutCheck } from './reconciler/checks/quote-selection-timeout.check';
import { StalledConfirmationCheck } from './reconciler/checks/stalled-confirmation.check';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaModule } from '../prisma/prisma.module';
import { RescueRequestController } from './rescue-request.controller';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { S3Module } from '../integrations/s3/s3.module';
import { GeocodingModule } from '../integrations/geocoding/geocoding.module';
import { OperatorModule } from '../operator/operator.module';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { RatingModule } from '../rating/rating.module';
import { PayoutModule } from '../payout/payout.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    PaystackModule,
    TwilioModule,
    S3Module,
    GeocodingModule,
    OperatorModule,
    PlatformConfigModule,
    RatingModule,
    PayoutModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [RescueRequestController],
  providers: [
    RescueRequestSharedService,
    DisputeService,
    PaymentEventsService,
    RescueRequestAdminService,
    DispatchService,
    OfferSweepCheck,
    DepositExpiryCheck,
    DepositReminderCheck,
    BiddingCloseCheck,
    BatchResolveCheck,
    QuoteSelectionTimeoutCheck,
    StalledConfirmationCheck,
    ReconcilerService,
    {
      // The checks the 15-second loop runs, in order. A check is registered
      // here and nowhere else, so this list is the whole inventory of
      // scheduled work in the service.
      provide: RECONCILER_CHECKS,
      useFactory: (
        offerSweep: OfferSweepCheck,
        depositExpiry: DepositExpiryCheck,
        depositReminder: DepositReminderCheck,
        biddingClose: BiddingCloseCheck,
        batchResolve: BatchResolveCheck,
        quoteSelectionTimeout: QuoteSelectionTimeoutCheck,
        stalledConfirmation: StalledConfirmationCheck,
      ) => [
        offerSweep,
        depositExpiry,
        depositReminder,
        biddingClose,
        batchResolve,
        quoteSelectionTimeout,
        stalledConfirmation,
      ],
      inject: [
        OfferSweepCheck,
        DepositExpiryCheck,
        DepositReminderCheck,
        BiddingCloseCheck,
        BatchResolveCheck,
        QuoteSelectionTimeoutCheck,
        StalledConfirmationCheck,
      ],
    },
    WhatsAppOperatorFlowService,
    WhatsAppCustomerFlowService,
    WhatsAppInboundService,
    WhatsAppSessionStore,
    AuthGuard,
  ],
  exports: [
    PaymentEventsService,
    RescueRequestAdminService,
    DispatchService,
    WhatsAppInboundService,
  ],
})
export class RescueRequestModule {}
