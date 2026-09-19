import { Module } from '@nestjs/common';
import { S3Module } from '../integrations/s3/s3.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  imports: [PrismaModule, S3Module],
  providers: [AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
