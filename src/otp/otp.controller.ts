import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { OtpService } from './otp.service';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { normalizePhone } from '../common/phone.util';
import {
  SMS_TRIGGER_THROTTLE_LIMIT,
  SMS_TRIGGER_THROTTLE_TTL_MS,
} from '../common/sms-throttle.constants';

@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  /**
   * Unauthenticated and accepts any phone number not already claimed by a
   * non-customer — OtpService caps sends per phone number, but nothing
   * stopped a single caller from cycling through many different numbers
   * until this per-IP guard. See common/sms-throttle.constants.ts.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: SMS_TRIGGER_THROTTLE_LIMIT,
      ttl: SMS_TRIGGER_THROTTLE_TTL_MS,
    },
  })
  @Post('send-code')
  async sendCode(@Body() dto: SendCodeDto) {
    return this.otpService.sendCode(normalizePhone(dto.phoneNumber));
  }

  @Post('verify-code')
  async verifyCode(@Body() dto: VerifyCodeDto) {
    return this.otpService.verifyCode(
      normalizePhone(dto.phoneNumber),
      dto.code,
    );
  }
}
