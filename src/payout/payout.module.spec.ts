import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PayoutModule } from './payout.module';
import { PrismaService } from '../prisma/prisma.service';

describe('PayoutModule (DI smoke test)', () => {
  it('compiles the full module graph without throwing', async () => {
    // tsc does not catch a missing Nest provider — only actually resolving
    // the graph does. PayoutService gained a TwilioService dependency for
    // operator payout notifications, so this guards that wiring.
    //
    // ConfigModule is only registered globally in AppModule (isGlobal: true),
    // so an isolated module test has to provide it explicitly — TwilioService
    // and PaystackService both inject ConfigService.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PayoutModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
  });
});
