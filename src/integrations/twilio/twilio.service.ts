import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

@Injectable()
export class TwilioService {
  private readonly client: Twilio;
  private readonly whatsappFrom: string;

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID') || '';
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.whatsappFrom = this.configService.get<string>('TWILIO_WHATSAPP_FROM') || '';

    this.client = new Twilio(accountSid, authToken);
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
}