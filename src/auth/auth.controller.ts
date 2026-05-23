import { Body, Controller, Get, Post, UseGuards, Request, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import * as bcrypt from 'bcrypt';
import { RegisterOperatorDto } from './dto/register-operator.dto';

export class LoginDto {
  email: string;
  password: string;
}

export class RegisterDto {
  email: string;
  password: string;
  name?: string;
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
   * Register a new user (for testing/admin)
   */
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register({
      email: dto.email,
      password: dto.password,
      name: dto.name,
    });
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
   * Register a new operator
   */
  @Post('register/operator')
  async registerOperator(@Body() dto: RegisterOperatorDto) {
    return this.authService.registerOperator(dto);
  }

  /**
   * Get current user profile
   */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@Request() req: any) {
    return this.authService.getUserById(req.user.id);
  }

  @Get('hash-password')
  async hashPassword(@Query('password') password: string) {
    if (!password) return { error: 'Password is required' };
    const hash = await bcrypt.hash(password, 10);
    return { hash };
  }
}