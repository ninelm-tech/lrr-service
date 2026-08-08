import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

@Injectable()
export class TwilioService {
  private readonly client: Twilio;
  private readonly whatsappFrom: string;
  private readonly accountSid: string;
  private readonly authToken: string;

  constructor(private readonly configService: ConfigService) {
    this.accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID') || '';
    this.authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.whatsappFrom = this.configService.get<string>('TWILIO_WHATSAPP_FROM') || '';

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
        to:   formattedTo,
        body: message,
      });
      console.log('WhatsApp message sent:', result.sid);
    } catch (error) {
      console.error('Failed to send WhatsApp message:', error);
      throw error;
    }
  }

  /**
   * Download media (photo/video/audio) from a Twilio-hosted MediaUrl.
   * Twilio media URLs require HTTP Basic Auth with the account SID/auth token.
   */
  async downloadMedia(url: string): Promise<Buffer> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
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