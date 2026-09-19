import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { Twilio } from 'twilio';

@Injectable()
export class TwilioService {
  private readonly client: Twilio;
  private readonly whatsappFrom: string;
  private readonly accountSid: string;
  private readonly authToken: string;

  constructor(private readonly configService: ConfigService) {
    this.accountSid =
      this.configService.get<string>('TWILIO_ACCOUNT_SID') || '';
    this.authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.whatsappFrom =
      this.configService.get<string>('TWILIO_WHATSAPP_FROM') || '';

    this.client = new Twilio(this.accountSid, this.authToken);
  }

  /**
   * Send a WhatsApp message to a user
   */
  async sendWhatsAppMessage(to: string, message: string): Promise<void> {
    try {
      // Accept either "+234..." or "whatsapp:+234..." — normalise here
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const result = await this.client.messages.create({
        from: `whatsapp:${this.whatsappFrom}`,
        to: formattedTo,
        body: message,
      });
      console.log('WhatsApp message sent:', result.sid);
    } catch (error) {
      console.error('Failed to send WhatsApp message:', error);
      throw error;
    }
  }

  /**
   * Send a WhatsApp message using an approved Content Template.
   * Required for any business-initiated message outside a 24-hour customer
   * session window (e.g. an OTP code, a staff alert) — Meta rejects a
   * freeform `sendWhatsAppMessage` body in that case. `variables` maps
   * template placeholder numbers to values, e.g. { "1": "A1B2C3", "2": "https://..." }
   * for a template body using {{1}} and {{2}}.
   */
  async sendWhatsAppTemplateMessage(
    to: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<void> {
    try {
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const result = await this.client.messages.create({
        from: `whatsapp:${this.whatsappFrom}`,
        to: formattedTo,
        contentSid,
        contentVariables: JSON.stringify(variables),
      });
      console.log('WhatsApp template message sent:', result.sid);
    } catch (error) {
      // Twilio's RestException carries the fields that actually identify
      // the problem (e.g. 21656 = ContentVariables don't match the
      // template's declared variables). error.message alone just says
      // "The Content Variables parameter is invalid", which is not enough
      // to tell a variable-shape bug from a bad ContentSid — attach the
      // structured fields, plus which SID and variable keys we sent.
      const twilioError = error as {
        code?: number;
        status?: number;
        moreInfo?: string;
        details?: unknown;
      };
      console.error('Failed to send WhatsApp template message:', {
        code: twilioError.code,
        status: twilioError.status,
        moreInfo: twilioError.moreInfo,
        details: twilioError.details,
        contentSid,
        sentVariableKeys: Object.keys(variables),
        error,
      });
      Sentry.captureException(error, {
        extra: {
          twilioCode: twilioError.code,
          twilioStatus: twilioError.status,
          twilioMoreInfo: twilioError.moreInfo,
          twilioDetails: twilioError.details,
          contentSid,
          sentVariableKeys: Object.keys(variables),
        },
      });
      throw error;
    }
  }

  /**
   * Download media (photo/video/audio) from a Twilio-hosted MediaUrl.
   * Twilio media URLs require HTTP Basic Auth with the account SID/auth token.
   */
  async downloadMedia(url: string): Promise<Buffer> {
    const credentials = Buffer.from(
      `${this.accountSid}:${this.authToken}`,
    ).toString('base64');
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download Twilio media: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
