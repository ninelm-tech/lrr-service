import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { normalizePhone } from '../common/phone.util';
import { OtpService } from '../otp/otp.service';

export interface JwtPayload {
  sub: string;
  email: string | null;
  role: UserRole;
}

export interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: UserRole;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly otpService: OtpService,
  ) {}

  /**
   * Hash a password
   */
  async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  /**
   * Verify a password against a hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Generate JWT token
   */
  generateToken(user: {
    id: string;
    email: string | null;
    role: UserRole;
  }): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwtService.sign(payload);
  }

  /**
   * Login with an identifier (email or phone number) and password
   */
  async login(identifier: string, password: string): Promise<AuthResponse> {
    let user = await this.prisma.user.findUnique({
      where: { email: identifier },
    });
    if (!user) {
      // identifier may be a phone number typed in local format (0801...)
      // rather than the E.164 form phoneNumber is stored in — normalize
      // before the lookup, same as every other phone-accepting entry point
      // (registerCustomer, operator.service.ts, the OTP login routes below).
      // Not every identifier IS a phone number — it could be a mistyped
      // email — so a normalization failure just means "not a phone either";
      // fall through to the same invalid-credentials rejection below rather
      // than letting normalizePhone's thrown Error escape unhandled.
      try {
        const normalizedPhone = normalizePhone(identifier);
        user = await this.prisma.user.findUnique({
          where: { phoneNumber: normalizedPhone },
        });
      } catch {
        user = null;
      }
    }

    if (!user || !user.passwordHash) {
      logger.warn('login: no account for this identifier', { identifier });
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await this.verifyPassword(
      password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      logger.warn('login: wrong password', {
        userId: user.id,
        role: user.role,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    logger.info('login: success', { userId: user.id, role: user.role });

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /**
   * Register a new user (generic - for admin use)
   */
  /**
   * Admin action: create a staff account (ADMIN or PRODUCT only — never
   * SUPER_ADMIN, never CUSTOMER/OPERATOR, which have their own dedicated
   * self-registration flows). Role restriction is enforced by the
   * controller before this is called; this method trusts its input.
   */
  async createStaff(data: {
    email: string;
    name: string;
    role: UserRole;
    temporaryPassword: string;
  }): Promise<{
    id: string;
    email: string | null;
    name: string | null;
    role: UserRole;
  }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.hashPassword(data.temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        role: data.role,
        passwordHash,
      },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  /**
   * Register a new customer (self-service via web or WhatsApp subscription flow).
   * Phone number is mandatory — it must match the WhatsApp number they SOS from.
   */
  async registerCustomer(dto: {
    phoneNumber: string;
    email?: string;
    password?: string;
    name?: string;
  }): Promise<AuthResponse> {
    // Normalise to E.164 — covers "080..." entered on the web form
    const phoneNumber = normalizePhone(dto.phoneNumber);

    // Check phone uniqueness
    const existingPhone = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });
    if (existingPhone) {
      // If already exists as a CUSTOMER (created automatically by WhatsApp bot),
      // just attach email/password and return a token.
      if (existingPhone.role === UserRole.CUSTOMER) {
        const updates: any = {};
        if (dto.name) updates.name = dto.name;
        if (dto.email) updates.email = dto.email;
        if (dto.password)
          updates.passwordHash = await this.hashPassword(dto.password);

        const updated = await this.prisma.user.update({
          where: { id: existingPhone.id },
          data: updates,
        });

        const accessToken = this.generateToken({
          id: updated.id,
          email: updated.email ?? phoneNumber,
          role: updated.role,
        });

        return {
          accessToken,
          user: {
            id: updated.id,
            email: updated.email,
            name: updated.name,
            role: updated.role,
          },
        };
      }

      logger.warn(
        'registerCustomer: phone already registered to a non-customer account',
        {
          phoneNumber,
          existingRole: existingPhone.role,
        },
      );
      throw new ConflictException(
        'Phone number already registered to a different account type.',
      );
    }

    // Check email uniqueness if provided
    if (dto.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existingEmail) {
        logger.warn('registerCustomer: email already registered', {
          email: dto.email,
        });
        throw new ConflictException('Email already registered.');
      }
    }

    const passwordHash = dto.password
      ? await this.hashPassword(dto.password)
      : null;

    const user = await this.prisma.user.create({
      data: {
        phoneNumber, // normalised +234... form
        email: dto.email ?? null,
        passwordHash: passwordHash ?? undefined,
        name: dto.name ?? null,
        role: UserRole.CUSTOMER,
      },
    });
    logger.info('registerCustomer: account created', { userId: user.id });

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email ?? phoneNumber,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  // ══════════════════════════════════════════════════════
  //  FORGOT PASSWORD
  // ══════════════════════════════════════════════════════

  /**
   * Resolves the account by email first, then phone number — two separate
   * lookups, never a combined OR (same convention as operator.service.ts).
   * The phone lookup normalizes first (same reasoning as AuthService.login,
   * Task 8): this pre-existing method (2026-08-19) had the identical gap —
   * a locally-formatted phone (0801...) never matched the E.164-stored
   * value, silently falling through to "no account" every time. Same file,
   * same bug class as Task 8's fix, folded in here rather than left stale
   * next to the corrected version.
   * The response message never reveals whether an account was found or
   * eligible — only `otpRequired` (always true) tells the caller a code was
   * (maybe) sent; requestPasswordReset never changes a password directly —
   * only resetPasswordWithCode does, after that code is verified.
   */
  async requestPasswordReset(
    identifier: string,
    newPassword: string,
  ): Promise<{ message: string; otpRequired: boolean }> {
    // ValidationPipe isn't wired up globally, so class-validator decorators
    // on ForgotPasswordDto alone don't run — enforce the length rule here
    // too (same pattern as e.g. rescue-request-admin.service.ts's manual
    // priceKobo check).
    if (newPassword.length < 8) {
      throw new BadRequestException(
        'newPassword must be at least 8 characters.',
      );
    }

    let user = await this.prisma.user.findUnique({
      where: { email: identifier },
    });
    if (!user) {
      try {
        const normalizedPhone = normalizePhone(identifier);
        user = await this.prisma.user.findUnique({
          where: { phoneNumber: normalizedPhone },
        });
      } catch {
        user = null;
      }
    }

    const genericMessage = {
      message:
        "If an account exists, we've sent a reset code to its registered phone number.",
      otpRequired: true,
    };
    if (!user || !user.passwordHash || !user.phoneNumber) {
      return genericMessage;
    }

    await this.otpService.sendPasswordResetCode(user.phoneNumber);
    return genericMessage;
  }

  /**
   * Verifies the code, then atomically claims its token and updates the
   * password in one transaction. Consumption is the claim itself — an
   * `updateMany` whose WHERE is the eligibility check — not a separate read
   * followed by a write, which would let two concurrent submissions of the
   * same code both pass a "not yet consumed" check before either commits.
   */
  async resetPasswordWithCode(
    phoneNumber: string,
    code: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    if (newPassword.length < 8) {
      throw new BadRequestException(
        'newPassword must be at least 8 characters.',
      );
    }

    const { token } = await this.otpService.verifyCode(phoneNumber, code);
    const tokenRow = await this.otpService.findValidTokenRow(
      phoneNumber,
      token,
    );
    if (!tokenRow) {
      throw new BadRequestException('Code expired — request a new one.');
    }
    const passwordHash = await this.hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.phoneVerification.updateMany({
        where: {
          id: tokenRow.id,
          consumedAt: null,
          tokenExpiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Code expired — request a new one.');
      }

      const user = await tx.user.findUnique({ where: { phoneNumber } });
      if (!user || !user.passwordHash) {
        throw new BadRequestException('No account found for this number.');
      }

      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
    });

    logger.info('resetPasswordWithCode: password updated', { phoneNumber });
    return { message: 'Password updated. You can now log in.' };
  }

  /**
   * Update the authenticated user's own profile.
   * Email and phone are checked for uniqueness; phone is normalised to E.164
   * (it is the WhatsApp identity, so it must stay canonical).
   */
  async updateProfile(
    userId: string,
    dto: { name?: string; email?: string; phoneNumber?: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const data: { name?: string | null; email?: string; phoneNumber?: string } =
      {};

    if (dto.name !== undefined) {
      data.name = dto.name.trim() || null;
    }

    if (dto.email !== undefined && dto.email.trim()) {
      const email = dto.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('Invalid email address');
      }
      if (email !== user.email) {
        const existing = await this.prisma.user.findUnique({
          where: { email },
        });
        if (existing && existing.id !== userId)
          throw new ConflictException('Email already in use');
        data.email = email;
      }
    }

    if (dto.phoneNumber !== undefined && dto.phoneNumber.trim()) {
      const phoneNumber = normalizePhone(dto.phoneNumber);
      if (phoneNumber !== user.phoneNumber) {
        const existing = await this.prisma.user.findUnique({
          where: { phoneNumber },
        });
        if (existing && existing.id !== userId)
          throw new ConflictException('Phone number already in use');
        data.phoneNumber = phoneNumber;
      }
    }

    if (Object.keys(data).length === 0) return this.getUserById(userId);

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
  }

  /**
   * Change (or set) the authenticated user's password.
   * Requires the current password when one exists. Customers created by the
   * WhatsApp bot have no password yet — they may set one directly.
   */
  async changePassword(
    userId: string,
    dto: { currentPassword?: string; newPassword: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    if (!dto.newPassword || dto.newPassword.length < 6) {
      throw new BadRequestException(
        'New password must be at least 6 characters',
      );
    }

    if (user.passwordHash) {
      if (!dto.currentPassword)
        throw new BadRequestException('Current password is required');
      const ok = await this.verifyPassword(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!ok) throw new UnauthorizedException('Current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.hashPassword(dto.newPassword) },
    });

    return { message: 'Password updated successfully' };
  }

  /**
   * Get user by ID
   */
  async getUserById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  /**
   * List users — admin use only.
   */
  async listUsers(opts: {
    role?: string;
    search?: string;
    page: number;
    limit: number;
  }) {
    const skip = (opts.page - 1) * opts.limit;
    const where: any = {};
    if (opts.role) where.role = opts.role;
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
        { phoneNumber: { contains: opts.search } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          phoneNumber: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: {
        page: opts.page,
        limit: opts.limit,
        total,
        pages: Math.ceil(total / opts.limit),
      },
    };
  }

  /**
   * Validate JWT payload and return user
   */
  async validateJwtPayload(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        name: true,
        role: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}
