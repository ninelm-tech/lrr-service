import { Body, Controller, Post, Headers, HttpCode } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('webhooks/payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('paystack')
  @HttpCode(200)
  async handlePaystackWebhook(
    @Body() body: any,
    @Headers('x-paystack-signature') signature: string,
  ) {
    // Verify webhook signature
    if (!this.paymentService.verifyWebhookSignature(body, signature)) {
      console.error('Invalid Paystack webhook signature');
      return { status: 'error', message: 'Invalid signature' };
    }

    console.log('Paystack webhook received:', body);

    return this.paymentService.handlePaystackWebhook(body);
  }
}
