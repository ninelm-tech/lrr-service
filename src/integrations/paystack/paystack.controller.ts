import { Controller, Get } from '@nestjs/common';
import { PaystackService } from './paystack.service';

@Controller('paystack')
export class PaystackController {
  constructor(private readonly paystackService: PaystackService) {}

  @Get('banks')
  async listBanks() {
    const banks = await this.paystackService.listBanks();
    return { data: banks };
  }
}
