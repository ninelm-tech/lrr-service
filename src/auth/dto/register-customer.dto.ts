import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Customer self-registration.
 * Phone number is the primary identifier (matches WhatsApp SOS phone) and
 * must be verified first via POST /otp/send-code + /otp/verify-code — see
 * AuthService.registerCustomer, which requires and consumes
 * phoneVerificationToken before touching the account. Without that, anyone
 * who knew a customer's phone number could set a new password on the
 * account the WhatsApp bot already created for them.
 * Email + password are optional — used only if they want dashboard login.
 */
export class RegisterCustomerDto {
  @IsString()
  phoneNumber: string;

  @IsString()
  phoneVerificationToken: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  name?: string;
}
