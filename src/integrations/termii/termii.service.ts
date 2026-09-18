import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';

@Injectable()
export class TermiiService {
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('TERMII_API_KEY') || '';
    this.senderId = this.configService.get<string>('TERMII_SENDER_ID') || 'LRR';
    this.baseUrl =
      this.configService.get<string>('TERMII_BASE_URL') ||
      'https://v3.api.termii.com/api';
  }

  /**
   * Plain SMS — Termii's generic send endpoint, not its OTP product. LRR
   * generates and verifies its own codes (see OtpService); this method only
   * delivers whatever text it's given.
   */
  async sendSms(phone: string, message: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          to: phone,
          from: this.senderId,
          sms: message,
          type: 'plain',
          channel: 'generic',
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('Termii sendSms failed:', {
          status: response.status,
          message: data.message,
        });
        Sentry.captureMessage('Termii sendSms failed', {
          level: 'error',
          extra: { status: response.status, message: data.message },
        });
        throw new InternalServerErrorException(
          'Failed to send SMS. Please try again.',
        );
      }
      console.log('SMS sent via Termii:', { messageId: data.message_id });
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      console.error('Termii sendSms error:', error);
      Sentry.captureException(error, { extra: { stage: 'termii-send-sms' } });
      throw new InternalServerErrorException(
        'Failed to send SMS. Please try again.',
      );
    }
  }
}
