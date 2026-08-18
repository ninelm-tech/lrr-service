import { IsArray, IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { OperatorType, TruckClass } from '@prisma/client';

export class CreateOperatorDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

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
  // identity). Distinct from businessPhoneNumber, which is the number
  // motorists and dispatch actually text.
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  // The business's dispatch WhatsApp line — becomes Operator.phoneNumber.
  // Usually the same as phoneNumber (solo operators); the frontend defaults
  // to copying it but lets it diverge.
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
}
