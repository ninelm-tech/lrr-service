import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { normalizePhone } from '../common/phone.util';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

export interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: UserRole;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
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
  generateToken(user: { id: string; email: string; role: UserRole }): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwtService.sign(payload);
  }

  /**
   * Login with email and password
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await this.verifyPassword(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email!,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email!,
        name: user.name,
        role: user.role,
      },
    };
  }

  /**
   * Register a new user (generic - for admin use)
   */
  async register(data: {
    email: string;
    password: string;
    name?: string;
    role?: UserRole;
  }): Promise<AuthResponse> {
    // Check if email already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Hash password
    const passwordHash = await this.hashPassword(data.password);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        name: data.name,
        role: data.role || UserRole.CUSTOMER,
      },
    });

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email!,
      role: user.role,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email!,
        name: user.name,
        role: user.role,
      },
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
        if (dto.name)     updates.name = dto.name;
        if (dto.email)    updates.email = dto.email;
        if (dto.password) updates.passwordHash = await this.hashPassword(dto.password);

        const updated = await this.prisma.user.update({
          where: { id: existingPhone.id },
          data:  updates,
        });

        const accessToken = this.generateToken({
          id:    updated.id,
          email: updated.email ?? phoneNumber,
          role:  updated.role,
        });

        return {
          accessToken,
          user: { id: updated.id, email: updated.email!, name: updated.name, role: updated.role },
        };
      }

      throw new ConflictException('Phone number already registered to a different account type.');
    }

    // Check email uniqueness if provided
    if (dto.email) {
      const existingEmail = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (existingEmail) throw new ConflictException('Email already registered.');
    }

    const passwordHash = dto.password ? await this.hashPassword(dto.password) : null;

    const user = await this.prisma.user.create({
      data: {
        phoneNumber,         // normalised +234... form
        email:        dto.email ?? null,
        passwordHash: passwordHash ?? undefined,
        name:         dto.name ?? null,
        role:         UserRole.CUSTOMER,
      },
    });

    const accessToken = this.generateToken({
      id:    user.id,
      email: user.email ?? phoneNumber,
      role:  user.role,
    });

    return {
      accessToken,
      user: { id: user.id, email: user.email!, name: user.name, role: user.role },
    };
  }

  /**
   * Register a new operator
   */
  async registerOperator(dto: {
    businessName: string;
    contactName: string;
    phoneNumber: string;
    email: string;
    address: string;
    latitude: number;
    longitude: number;
    type: string;
    password: string;
  }) {
    // Normalise phone to E.164 at the registration boundary
    const phoneNumber = normalizePhone(dto.phoneNumber);

    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Check if operator already exists (by businessName or phoneNumber)
    const existingOperator = await this.prisma.operator.findFirst({
      where: {
        OR: [
          { businessName: dto.businessName },
          { phoneNumber },
        ],
      },
    });
    if (existingOperator) {
      throw new ConflictException('Operator with this business name or phone number already exists');
    }

    const passwordHash = await this.hashPassword(dto.password);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        phoneNumber,
        email: dto.email,
        passwordHash,
        name: dto.contactName,
        role: 'OPERATOR',
      },
    });

    // Create operator
    const operator = await this.prisma.operator.create({
      data: {
        businessName: dto.businessName,
        contactName: dto.contactName,
        phoneNumber,
        email: dto.email,
        address: dto.address,
        latitude: Number(dto.latitude),
        longitude: Number(dto.longitude),
        type: dto.type as any, // Cast to enum, or use Prisma.OperatorType if imported
      },
    });

    // Create OperatorMember (OWNER)
    const operatorMember = await this.prisma.operatorMember.create({
      data: {
        userId: user.id,
        operatorId: operator.id,
        role: 'OWNER',
      },
    });

    return { user, operator, operatorMember };
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
        { name:        { contains: opts.search, mode: 'insensitive' } },
        { email:       { contains: opts.search, mode: 'insensitive' } },
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
          id: true, email: true, phoneNumber: true, name: true,
          role: true, createdAt: true, updatedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { page: opts.page, limit: opts.limit, total, pages: Math.ceil(total / opts.limit) },
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
