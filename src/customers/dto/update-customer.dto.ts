import { IsOptional, IsString } from 'class-validator';

/**
 * Phone number is deliberately absent: it is the customer's login identity
 * (OTP / WhatsApp), so changing it is a separate, verified flow.
 */
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  name?: string;

  /** null clears the email. */
  @IsOptional()
  @IsString()
  email?: string | null;
}
