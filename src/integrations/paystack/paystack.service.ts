import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface InitializePaymentParams {
  email: string;
  amount: number; // in kobo (e.g., 500000 = ₦5,000)
  reference: string;
  metadata?: Record<string, any>;
}

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    status: string; // 'success', 'failed', 'abandoned'
    reference: string;
    amount: number;
    paid_at: string;
    channel: string;
    customer: {
      email: string;
      phone: string;
    };
    metadata: Record<string, any>;
  };
}

@Injectable()
export class PaystackService {
  private readonly baseUrl = 'https://api.paystack.co';
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    this.secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY') || '';
  }

  /**
   * Initialize a payment and get a payment link
   */
  async initializePayment(params: InitializePaymentParams): Promise<PaystackInitializeResponse> {
    const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amount,
        reference: params.reference,
        metadata: params.metadata,
      }),
    });

    const data = await response.json();
    console.log('Paystack initialize response:', data);
    return data as PaystackInitializeResponse;
  }

  /**
   * Verify a payment by reference
   */
  async verifyPayment(reference: string): Promise<PaystackVerifyResponse> {
    const response = await fetch(`${this.baseUrl}/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    console.log('Paystack verify response:', data);
    return data as PaystackVerifyResponse;
  }

  /**
   * Generate a unique payment reference
   */
  generateReference(prefix: string = 'LRR'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
