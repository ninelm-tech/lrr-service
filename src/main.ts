import 'dotenv/config';
// ⚠️  Sentry MUST be imported before any other module
import './instrument';
import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true preserves the exact request bytes on req.rawBody alongside
  // the parsed body — required to verify the Paystack webhook HMAC signature,
  // which is computed over Paystack's original bytes, not a re-serialized copy.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      const allowed = [
        frontendUrl,                          // staging.lrr.ninelm.com or lrr.ninelm.com
        'http://localhost:3000',              // local web dev
        'http://localhost:3001',              // local web dev (alt port)
      ];

      // Allow all Vercel preview deployments (*.vercel.app)
      const isVercelPreview = /^https:\/\/[a-z0-9-]+-[a-z0-9]+-ninelm\.vercel\.app$/.test(origin)
        || origin.endsWith('.vercel.app');

      if (allowed.includes(origin) || isVercelPreview) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin not allowed — ${origin}`));
      }
    },
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  Sentry.captureException(err);
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
