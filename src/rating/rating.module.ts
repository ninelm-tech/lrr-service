import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    // resolve-flag is admin-guarded (AuthGuard/RolesGuard) — needs its own
    // JwtService, same pattern as RescueRequestModule.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [RatingController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}
