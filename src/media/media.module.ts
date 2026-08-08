import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../integrations/s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module],
  controllers: [MediaController],
})
export class MediaModule {}
