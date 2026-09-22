import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { TermiiSendOtpResponse } from './dto/send-otp-response.dto';
import { TermiiVerifyOtpResponse } from './dto/verify-otp-response.dto';

const DEFAULT_PIN_ATTEMPTS = 3;
const DEFAULT_PIN_LENGTH = 6;

@Injectable()
export class TermiiService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('TERMII_API_KEY') || '';
    this.baseUrl =
      this.configService.get<string>('TERMII_BASE_URL') ||
      'https://v3.api.termii.com/api';
  }

  /**
   * Termii's OTP product (not the generic /sms/send endpoint) — Termii
   * generates, delivers, and holds the actual code server-side; this
   * returns only the pinId needed to verify it later. Delivered over the
   * 'dnd' channel (bypasses a recipient's Do-Not-Disturb setting), which on
   * this account requires the specific shared sender id Termii activated
   * for it — 'OE Alert', confirmed directly by Termii support (Chinenye
   * Umeizu, 2026-09-20). NOT the same value another account (zalyx) uses —
   * this is assigned per-account, not a platform-wide constant.
   */
  async sendOtp(
    phone: string,
    messageText: string,
    pinTimeToLiveMinutes: number,
  ): Promise<{ pinId: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/sms/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          message_type: 'NUMERIC',
          to: phone,
          from: 'OE Alert',
          channel: 'dnd',
          pin_attempts: DEFAULT_PIN_ATTEMPTS,
          pin_time_to_live: pinTimeToLiveMinutes,
          pin_length: DEFAULT_PIN_LENGTH,
          pin_placeholder: '< 1234 >',
          message_text: messageText,
          pin_type: 'NUMERIC',
        }),
      });

      const { data, raw } =
        await this.parseBody<TermiiSendOtpResponse>(response);
      if (!response.ok || !data?.pinId) {
        this.reportFailure('sendOtp', response.status, data?.message, raw);
        throw new InternalServerErrorException(
          'Failed to send OTP. Please try again.',
        );
      }

      console.log('OTP sent via Termii', { pinId: data.pinId });
      return { pinId: data.pinId };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      console.error('Termii sendOtp error:', error);
      Sentry.captureException(error, { extra: { stage: 'termii-send-otp' } });
      throw new InternalServerErrorException(
        'Failed to send OTP. Please try again.',
      );
    }
  }

  /**
   * Checks a code against Termii's own record for pinId — LRR never learns
   * or stores the code itself. `verified` comes back as either the string
   * 'True' (per Termii's docs) or a real boolean true (observed in
   * production: valid codes were accepted with HTTP 200 and then rejected
   * by an exact === 'True' check) — anything else, e.g. 'Expired', is a
   * failure. Normalized to a boolean here so callers never need to know.
   *
   * NOT idempotent: Termii pins are single-use, so a second call for the
   * same pinId fails with 400 "already been verified".
   */
  async verifyOtp(
    pinId: string,
    pin: string,
  ): Promise<{ verified: boolean; alreadyUsed?: boolean }> {
    try {
      const response = await fetch(`${this.baseUrl}/sms/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          pin_id: pinId,
          pin,
        }),
      });

      const { data, raw } =
        await this.parseBody<TermiiVerifyOtpResponse>(response);
      if (!response.ok) {
        // Expected, not a fault: the pin was already redeemed (a double
        // click, a retry after a later step failed). A returned fact rather
        // than an error so it never pages as a 500 or reads as an outage.
        if (
          response.status === 400 &&
          /already been verified/i.test(data?.message ?? '')
        ) {
          console.warn('Termii verifyOtp: pin already used');
          return { verified: false, alreadyUsed: true };
        }
        this.reportFailure('verifyOtp', response.status, data?.message, raw);
        throw new InternalServerErrorException(
          'Verification failed. Please try again or request a new OTP.',
        );
      }

      const verified =
        data?.verified === true ||
        (typeof data?.verified === 'string' &&
          data.verified.toLowerCase() === 'true');
      if (!verified) {
        // Shape only — never the pin, pinId or phone number.
        console.warn('Termii verifyOtp: not verified', {
          verified: data?.verified,
          verifiedType: typeof data?.verified,
          keys: data ? Object.keys(data) : null,
        });
      }
      return { verified };
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      console.error('Termii verifyOtp error:', error);
      Sentry.captureException(error, {
        extra: { stage: 'termii-verify-otp' },
      });
      throw new InternalServerErrorException(
        'Verification failed. Please try again or request a new OTP.',
      );
    }
  }

  /**
   * Reads the body as text first, then tries to parse it as JSON — never
   * the other way around. Termii can return a genuinely empty body (e.g. a
   * 401 on a bad key), and `response.json()` throws on that, which used to
   * crash straight into the generic catch block and lose the real status
   * and message before they could ever be logged.
   */
  private async parseBody<T>(
    response: Response,
  ): Promise<{ data: T | null; raw: string }> {
    const raw = await response.text();
    try {
      return { data: raw ? (JSON.parse(raw) as T) : null, raw };
    } catch {
      return { data: null, raw };
    }
  }

  private reportFailure(
    operation: string,
    status: number,
    message: string | undefined,
    raw: string,
  ): void {
    console.error(`Termii ${operation} failed:`, { status, message, raw });
    Sentry.captureMessage(`Termii ${operation} failed`, {
      level: 'error',
      extra: { status, message, raw },
    });
  }
}
