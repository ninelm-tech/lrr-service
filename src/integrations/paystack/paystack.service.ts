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

  // ── Paystack Customers ───────────────────────────────────────────────────

  /**
   * Create or fetch a Paystack customer by email.
   * Returns the customer_code used for subscriptions.
   */
  async createOrFetchCustomer(params: {
    email: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
  }): Promise<{ customer_code: string; id: number }> {
    // Try fetching first
    const fetchRes = await fetch(`${this.baseUrl}/customer/${params.email}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const fetchData = await fetchRes.json() as any;

    if (fetchData.status && fetchData.data?.customer_code) {
      return { customer_code: fetchData.data.customer_code, id: fetchData.data.id };
    }

    // Create new customer
    const createRes = await fetch(`${this.baseUrl}/customer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    const createData = await createRes.json() as any;
    console.log('Paystack create customer:', createData);
    return { customer_code: createData.data.customer_code, id: createData.data.id };
  }

  // ── Paystack Plans ───────────────────────────────────────────────────────

  /**
   * Create a Paystack plan (recurring billing).
   * Returns the plan_code.
   */
  async createPlan(params: {
    name: string;
    amount: number;       // in kobo
    interval: 'monthly' | 'annually';
    description?: string;
  }): Promise<{ plan_code: string; id: number }> {
    const res = await fetch(`${this.baseUrl}/plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    const data = await res.json() as any;
    console.log('Paystack create plan:', data);
    return { plan_code: data.data.plan_code, id: data.data.id };
  }

  /**
   * Update an existing Paystack plan (e.g. price change).
   * Note: only affects NEW subscriptions — existing subscribers keep their old amount.
   */
  async updatePlan(planCode: string, params: {
    name?: string;
    amount?: number;      // in kobo
    interval?: 'monthly' | 'annually';
    description?: string;
  }): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/plan/${planCode}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    const data = await res.json() as any;
    console.log('Paystack update plan:', planCode, data?.status, data?.message);
    return Boolean(data?.status);
  }

  /**
   * List plans — used to find existing plans by name at startup.
   */
  async listPlans(): Promise<Array<{ id: number; plan_code: string; name: string; amount: number; interval: string }>> {
    const res = await fetch(`${this.baseUrl}/plan?perPage=50`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const data = await res.json() as any;
    return data.data ?? [];
  }

  // ── Paystack Subscriptions ───────────────────────────────────────────────

  /**
   * Initialize a subscription via checkout page (customer pays first charge + subscribes).
   * Returns the authorization_url to send to the customer.
   */
  async initializeSubscriptionCheckout(params: {
    email: string;
    amount: number;
    plan: string;            // plan_code
    reference: string;
    callback_url?: string;   // where Paystack redirects after payment
    metadata?: Record<string, any>;
  }): Promise<PaystackInitializeResponse> {
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email:        params.email,
        amount:       params.amount,
        plan:         params.plan,
        reference:    params.reference,
        callback_url: params.callback_url,
        metadata:     params.metadata,
      }),
    });
    const data = await res.json() as any;
    console.log('Paystack subscription checkout init:', data);
    return data as PaystackInitializeResponse;
  }

  /**
   * Cancel a Paystack subscription.
   */
  async cancelSubscription(params: {
    code: string;            // subscription_code
    token: string;           // email_token from Paystack subscription object
  }): Promise<{ status: boolean; message: string }> {
    const res = await fetch(`${this.baseUrl}/subscription/disable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    const data = await res.json() as any;
    console.log('Paystack cancel subscription:', data);
    return data;
  }

  /**
   * Fetch a Paystack subscription by code.
   */
  async fetchSubscription(subscriptionCode: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/subscription/${subscriptionCode}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    return (await res.json() as any).data;
  }
}
