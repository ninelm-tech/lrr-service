import { Module } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { OperatorController } from './operator.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [OperatorService],
  controllers: [OperatorController],
  exports: [OperatorService],
})
export class OperatorModule {}
