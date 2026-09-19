import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { S3Module } from '../integrations/s3/s3.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AuthGuard } from '../auth/auth.guard';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';
import { AccountDeletionTickerService } from './account-deletion-ticker.service';

@Module({
  imports: [
    PrismaModule,
    S3Module,
    AuditLogModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    AuthGuard,
    PurgeExpiredFinancialDataCheck,
    RetryMediaDeletionCheck,
    AccountDeletionTickerService,
  ],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
