import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { OperatorType, TruckClass } from '@prisma/client';

// Staff-onboarded operator, entered from a physical intake form in the
// field — no OTP phone verification (staff already verified identity in
// person) and no password requirement (see OperatorService.adminCreate).
export class AdminCreateOperatorDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  // Optional — if omitted, the operator has no password set and must use
  // "Forgot password" before they can log in.
  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(OperatorType)
  @IsOptional()
  type?: OperatorType;

  @IsString()
  @IsNotEmpty()
  businessName: string;

  @IsString()
  @IsNotEmpty()
  contactName: string;

  // The registrant's own number — becomes User.phoneNumber (their login/
  // identity). Distinct from businessPhoneNumber, same as self-registration.
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  // The business's dispatch WhatsApp line — becomes Operator.phoneNumber.
  @IsString()
  @IsNotEmpty()
  businessPhoneNumber: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsNumber()
  @IsOptional()
  serviceRadius?: number;

  @IsArray()
  @IsEnum(TruckClass, { each: true })
  truckClasses: TruckClass[];

  // Decorators here are documentation only — see OperatorService.adminCreate,
  // which validates this by hand the same way it already validates
  // truckClasses (no global ValidationPipe is wired up in this app).
  @IsNumber()
  @IsOptional()
  depositPercentOverride?: number | null;

  @IsBoolean()
  @IsOptional()
  whatsappEnabled?: boolean;
}
