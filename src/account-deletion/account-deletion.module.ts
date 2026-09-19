import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { S3Module } from '../integrations/s3/s3.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    S3Module,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService, AuthGuard],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
