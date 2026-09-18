import 'dotenv/config';
// ⚠️  Sentry MUST be imported before any other module
import './instrument';
import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true preserves the exact request bytes on req.rawBody alongside
  // the parsed body — required to verify the Paystack webhook HMAC signature,
  // which is computed over Paystack's original bytes, not a re-serialized copy.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // This service runs on AWS ECS Fargate behind an ALB, with the ALB as the
  // single reverse-proxy hop directly in front of this task (no CDN/extra
  // proxy layer in between, as is typical for a backend API that isn't
  // serving public/cacheable content). Trusting exactly 1 hop makes Express's
  // req.ip — which @nestjs/throttler's default per-IP throttling (see
  // OtpModule/AuthModule ThrottlerGuard usage) relies on — read the real
  // client IP from the X-Forwarded-For header the ALB sets, rather than the
  // ALB's own IP for every request. `true` is deliberately avoided: it trusts
  // the entire X-Forwarded-For chain, which would let a malicious client
  // spoof their own IP by prepending fake entries to that header.
  //
  // CAVEAT: the "1" here is inferred from the known deployment topology
  // (client -> ALB -> this ECS task), not verified from code. If an
  // additional proxy layer (e.g. CloudFront) sits between the ALB and this
  // service, this value needs to increase accordingly — confirm the actual
  // hop count with whoever owns the infrastructure before relying on this
  // for rate-limiting/logging correctness.
  app.set('trust proxy', 1);

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      const allowed = [
        frontendUrl, // staging.lrr.ninelm.com or lrr.ninelm.com
        'http://localhost:3000', // local web dev
        'http://localhost:3001', // local web dev (alt port)
      ];

      // Allow all Vercel preview deployments (*.vercel.app)
      const isVercelPreview =
        /^https:\/\/[a-z0-9-]+-[a-z0-9]+-ninelm\.vercel\.app$/.test(origin) ||
        origin.endsWith('.vercel.app');

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
