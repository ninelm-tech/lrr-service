import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RescueRequestModule } from './rescue-request.module';
import { PrismaService } from '../prisma/prisma.service';

describe('RescueRequestModule (DI smoke test)', () => {
  it('compiles the full module graph without throwing', async () => {
    // ConfigModule is only registered globally in AppModule (isGlobal: true)
    // — an isolated module test needs it explicitly, same as the real app
    // effectively provides it everywhere.
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), RescueRequestModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
  });
});
