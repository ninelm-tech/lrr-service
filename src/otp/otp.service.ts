import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TermiiService } from '../integrations/termii/termii.service';
import { UserRole } from '@prisma/client';

const CODE_TTL_MINUTES = 10;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly termiiService: TermiiService,
  ) {}

  async sendCode(
    phoneNumber: string,
  ): Promise<{ required: boolean; available?: boolean }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (existingUser && existingUser.role !== UserRole.CUSTOMER) {
      return { required: false, available: false };
    }

    // Brand-new phone (fresh operator signup) or an existing CUSTOMER
    // (upgrade path) — both now verify ownership before proceeding.
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
  async sendPasswordResetCode(
    phoneNumber: string,
  ): Promise<{ required: boolean }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });
    if (!existingUser || !existingUser.passwordHash) {
      return { required: false };
    }

    await this.sendCodeToPhone(phoneNumber, 'password reset code');
    return { required: true };
  }

  /**
   * OTP-based login — unlike sendCode (upgrade/signup verification) and
   * sendPasswordResetCode (any role with a portal password), eligibility here
   * is role === OPERATOR only: this route trades a password for a single SMS
   * code, a strictly weaker factor than what CUSTOMER/ADMIN/SUPER_ADMIN
   * accounts assume. The response never reveals whether the number is
   * unknown, ineligible, or genuinely sent — same account-enumeration
   * defense as sendPasswordResetCode's generic messaging, applied to the
   * return value itself since this endpoint has no separate message field.
   */
  async sendLoginCode(phoneNumber: string): Promise<{ required: boolean }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });
    if (existingUser?.role === UserRole.OPERATOR) {
      try {
        await this.sendCodeToPhone(phoneNumber, 'login code');
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        // Swallow the rate-limit error too — letting it escape would leak
        // "this phone is a real, eligible OPERATOR account" via a side
        // channel (error vs. no error) even though the response body is
        // already uniform. The caller sees the same generic outcome either
        // way: sent, rate-limited, or ineligible are indistinguishable.
      }
    }
    return { required: true };
  }

  private async sendCodeToPhone(
    phoneNumber: string,
    label: string,
  ): Promise<void> {
    const recent = await this.prisma.phoneVerification.findMany({
      where: {
        phoneNumber,
        createdAt: { gte: new Date(Date.now() - SEND_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (
      recent.length > 0 &&
      Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      throw new BadRequestException(
        'Please wait before requesting another code.',
      );
    }
    if (recent.length >= MAX_SENDS_PER_WINDOW) {
      throw new BadRequestException(
        'Too many code requests — please try again later.',
      );
    }

    // Termii generates and holds the actual code — we only get back the
    // pinId needed to verify it later, so the send has to happen before
    // there's a row to create.
    const { pinId } = await this.termiiService.sendOtp(
      phoneNumber,
      `Your LRR ${label} is < 1234 >. It expires in ${CODE_TTL_MINUTES} minutes.`,
      CODE_TTL_MINUTES,
    );

    await this.prisma.phoneVerification.create({
      data: {
        phoneNumber,
        pinId,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
  }

  async verifyCode(
    phoneNumber: string,
    code: string,
  ): Promise<{ token: string }> {
    const row = await this.prisma.phoneVerification.findFirst({
      where: { phoneNumber, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      throw new BadRequestException(
        'Code expired or not found — request a new one.',
      );
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts — request a new code.');
    }

    const { verified } = await this.termiiService.verifyOtp(row.pinId, code);
    if (!verified) {
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
