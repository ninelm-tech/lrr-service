import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthGuard } from '../auth/auth.guard';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
    AuditLogModule,
  ],
  controllers: [StaffController],
  providers: [StaffService, AuthGuard],
})
export class StaffModule {}
