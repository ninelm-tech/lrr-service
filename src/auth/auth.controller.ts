import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
  Request,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CreateStaffDto } from './dto/create-staff.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { SendLoginCodeDto, VerifyLoginCodeDto } from './dto/login-otp.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedRequest } from './authenticated-request.interface';
import { normalizePhone } from '../common/phone.util';
import {
  SMS_TRIGGER_THROTTLE_LIMIT,
  SMS_TRIGGER_THROTTLE_TTL_MS,
} from '../common/sms-throttle.constants';

export class UpdateProfileDto {
  name?: string;
  email?: string;
  phoneNumber?: string;
}

export class ChangePasswordDto {
  currentPassword?: string;
  newPassword: string;
}

export class LoginDto {
  identifier: string; // email or phone number
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Login with an identifier (email or phone number) and password
   */
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.identifier, dto.password);
  }

  /**
   * Create a staff account (SUPER_ADMIN only). role is restricted to
   * ADMIN or PRODUCT — SUPER_ADMIN is never created through this endpoint,
   * even by a SUPER_ADMIN caller (no self-service path to a second
   * SUPER_ADMIN account).
   */
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('staff')
  async createStaff(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateStaffDto,
  ) {
    if (dto.role !== UserRole.ADMIN && dto.role !== UserRole.PRODUCT) {
      throw new BadRequestException('role must be ADMIN or PRODUCT');
    }
    const user = await this.authService.createStaff(dto);
    await this.auditLogService.record({
      category: 'staff_created',
      message: `Created ${dto.role} staff account for ${dto.email}`,
      details: { newUserId: user.id, role: dto.role, email: dto.email },
      actorId: req.user.userId,
    });
    return { message: 'Staff account created', data: user };
  }

  /**
   * Register a new customer (self-service).
   * Phone number is required — it must match the WhatsApp number they'll SOS from.
   * Returns a JWT so they can log in immediately.
   */
  @Post('register/customer')
  async registerCustomer(@Body() dto: RegisterCustomerDto) {
    return this.authService.registerCustomer(dto);
  }

  /**
   * Request a password-reset code (email or phone). Unauthenticated by
   * definition — the caller is locked out. Response is always generic,
   * never reveals whether an account was found.
   */
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(
      dto.identifier,
      dto.newPassword,
    );
  }

  /**
   * Verify a password-reset code and set the new password.
   */
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPasswordWithCode(
      dto.phoneNumber,
      dto.code,
      dto.newPassword,
    );
  }

  /**
   * Request a phone+OTP login code (OPERATOR only — see
   * OtpService.sendLoginCode). Response is always the same generic shape,
   * never reveals whether an account was found or is eligible.
   *
   * Unauthenticated by design (it's the login entry point) and accepts any
   * phone number — per-IP throttled on top of OtpService's per-phone-number
   * cap. See common/sms-throttle.constants.ts.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: SMS_TRIGGER_THROTTLE_LIMIT,
      ttl: SMS_TRIGGER_THROTTLE_TTL_MS,
    },
  })
  @Post('login/otp/send')
  async sendLoginCode(@Body() dto: SendLoginCodeDto) {
    return this.authService.sendLoginCode(normalizePhone(dto.phoneNumber));
  }

  /**
   * Verify a phone+OTP login code and issue a token. OPERATOR-only — see
   * AuthService.loginWithOtp.
   */
  @Post('login/otp/verify')
  async loginWithOtp(@Body() dto: VerifyLoginCodeDto) {
    return this.authService.loginWithOtp(
      normalizePhone(dto.phoneNumber),
      dto.code,
    );
  }

  /**
   * Get current user profile
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@Request() req: any) {
    return this.authService.getUserById(req.user.id);
  }

  /**
   * Update the current user's profile (name, email, phone).
   */
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    const user = await this.authService.updateProfile(req.user.id, dto);
    return { message: 'Profile updated', data: user };
  }

  /**
   * Change (or set) the current user's password.
   */
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  /**
   * List all users — Super Admin only.
   * Supports ?role=CUSTOMER|OPERATOR|ADMIN|SUPER_ADMIN&search=&page=&limit=
   */
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('users')
  async listUsers(
    @Query('role') role?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '25',
  ) {
    return this.authService.listUsers({
      role,
      search,
      page: +page,
      limit: +limit,
    });
  }
}
