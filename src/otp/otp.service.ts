import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { UserRole } from '@prisma/client';

const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  /** Exposed only so tests can compute a matching codeHash without duplicating the hash fn. */
  hashForTest(code: string): string {
    return hash(code);
  }

  async sendCode(phoneNumber: string): Promise<{ required: boolean; available?: boolean }> {
    const existingUser = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (!existingUser) {
      return { required: false, available: true };
    }
    if (existingUser.role !== UserRole.CUSTOMER) {
      return { required: false, available: false };
    }

    await this.sendCodeToPhone(phoneNumber, 'verification code');
    return { required: true };
  }

  /**
   * Password-reset code delivery — unlike sendCode, eligibility here is
   * "has a portal login" (any role), not "is a CUSTOMER" (upgrade
   * eligibility). Deliberately kept as a separate method rather than
   * loosening sendCode's role check, since the two callers have genuinely
   * different eligibility rules.
   */
  async sendPasswordResetCode(phoneNumber: string): Promise<{ required: boolean }> {
    const existingUser = await this.prisma.user.findUnique({ where: { phoneNumber } });
    if (!existingUser || !existingUser.passwordHash) {
      return { required: false };
    }

    await this.sendCodeToPhone(phoneNumber, 'password reset code');
    return { required: true };
  }

  private async sendCodeToPhone(phoneNumber: string, label: string): Promise<void> {
    const recent = await this.prisma.phoneVerification.findMany({
      where: { phoneNumber, createdAt: { gte: new Date(Date.now() - SEND_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent.length > 0 && Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException('Please wait before requesting another code.');
    }
    if (recent.length >= MAX_SENDS_PER_WINDOW) {
      throw new BadRequestException('Too many code requests — please try again later.');
    }

    const code = generateCode();
    await this.prisma.phoneVerification.create({
      data: {
        phoneNumber,
        codeHash: hash(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(phoneNumber),
      `Your LRR ${label} is ${code}. It expires in 10 minutes.`,
    );
  }

  async verifyCode(phoneNumber: string, code: string): Promise<{ token: string }> {
    const row = await this.prisma.phoneVerification.findFirst({
      where: { phoneNumber, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      throw new BadRequestException('Code expired or not found — request a new one.');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts — request a new code.');
    }
    if (row.codeHash !== hash(code)) {
      await this.prisma.phoneVerification.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1 },
      });
      throw new BadRequestException('Incorrect code.');
    }

    const token = generateToken();
    await this.prisma.phoneVerification.update({
      where: { id: row.id },
      data: {
        verifiedAt: new Date(),
        verificationTokenHash: hash(token),
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    return { token };
  }

  /**
   * Called from operator.service.ts inside the upgrade transaction. Finds
   * the EXACT row for this token + phone (never "latest for phone") and
   * confirms it's unexpired and not already consumed. Returns the row id
   * so the caller can mark it consumed atomically with the rest of the
   * upgrade — this method does not itself mutate anything.
   */
  async findValidTokenRow(phoneNumber: string, token: string) {
    return this.prisma.phoneVerification.findFirst({
      where: {
        phoneNumber,
        verificationTokenHash: hash(token),
        tokenExpiresAt: { gt: new Date() },
        consumedAt: null,
      },
    });
  }
}
