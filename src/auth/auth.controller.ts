import { Body, Controller, Get, Patch, Post, UseGuards, Request, Query, BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CreateStaffDto } from './dto/create-staff.dto';

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
  email: string;
  password: string;
}

/**
 * Customer self-registration.
 * Phone number is the primary identifier (matches WhatsApp SOS phone).
 * Email + password are optional — used only if they want dashboard login.
 */
export class RegisterCustomerDto {
  phoneNumber: string;
  email?: string;
  password?: string;
  name?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Login with email and password
   */
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
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
  async createStaff(@Body() dto: CreateStaffDto) {
    if (dto.role !== UserRole.ADMIN && dto.role !== UserRole.PRODUCT) {
      throw new BadRequestException('role must be ADMIN or PRODUCT');
    }
    const user = await this.authService.createStaff(dto);
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
    return this.authService.listUsers({ role, search, page: +page, limit: +limit });
  }
}