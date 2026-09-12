import { Body, Controller, Post } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { normalizePhone } from '../common/phone.util';

@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('send-code')
  async sendCode(@Body() dto: SendCodeDto) {
    return this.otpService.sendCode(normalizePhone(dto.phoneNumber));
  }

  @Post('verify-code')
  async verifyCode(@Body() dto: VerifyCodeDto) {
    return this.otpService.verifyCode(normalizePhone(dto.phoneNumber), dto.code);
  }
}
