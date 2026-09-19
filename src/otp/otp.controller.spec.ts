import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import {
  SMS_TRIGGER_THROTTLE_LIMIT,
  SMS_TRIGGER_THROTTLE_TTL_MS,
} from '../common/sms-throttle.constants';

describe('OtpController', () => {
  let app: INestApplication<App>;
  let otpService: { sendCode: jest.Mock; verifyCode: jest.Mock };

  beforeEach(async () => {
    otpService = {
      sendCode: jest.fn().mockResolvedValue({ required: true }),
      verifyCode: jest.fn().mockResolvedValue({ token: 'tok' }),
    };

    // Real ThrottlerModule + real ThrottlerGuard, wired exactly as in
    // AppModule/OtpModule (see src/app.module.ts, src/otp/otp.module.ts) —
    // only OtpService is mocked. Proves the per-IP guard on POST
    // /otp/send-code actually rejects, not just that the decorators are
    // present.
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            ttl: SMS_TRIGGER_THROTTLE_TTL_MS,
            limit: SMS_TRIGGER_THROTTLE_LIMIT,
          },
        ]),
      ],
      controllers: [OtpController],
      providers: [
        { provide: OtpService, useValue: otpService },
        ThrottlerGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows up to the per-IP limit on /otp/send-code, then rejects the next request with 429', async () => {
    const server = app.getHttpServer();

    for (let i = 0; i < SMS_TRIGGER_THROTTLE_LIMIT; i++) {
      const res = await request(server)
        .post('/otp/send-code')
        .send({ phoneNumber: `+234801234567${i}` });
      expect(res.status).toBeLessThan(400);
    }
    expect(otpService.sendCode).toHaveBeenCalledTimes(
      SMS_TRIGGER_THROTTLE_LIMIT,
    );

    // One more request from the same IP, still within the window — the
    // per-IP cap fires even though each request used a different phone
    // number (that's the gap this guard closes; OtpService's own
    // per-phone-number cap would not catch this).
    const blocked = await request(server)
      .post('/otp/send-code')
      .send({ phoneNumber: '+2348099999999' });

    expect(blocked.status).toBe(429);
    // Still only called the limit's worth of times — the blocked request
    // never reached the controller/service.
    expect(otpService.sendCode).toHaveBeenCalledTimes(
      SMS_TRIGGER_THROTTLE_LIMIT,
    );
  });

  it('does not throttle /otp/verify-code — the guard is scoped to send-code only', async () => {
    const server = app.getHttpServer();

    for (let i = 0; i < SMS_TRIGGER_THROTTLE_LIMIT + 2; i++) {
      const res = await request(server)
        .post('/otp/verify-code')
        .send({ phoneNumber: '+2348012345678', code: '123456' });
      expect(res.status).toBeLessThan(400);
    }
    expect(otpService.verifyCode).toHaveBeenCalledTimes(
      SMS_TRIGGER_THROTTLE_LIMIT + 2,
    );
  });
});
