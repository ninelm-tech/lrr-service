import { IsString, IsNotEmpty, IsEmail, IsNumber } from 'class-validator';

export class RegisterOperatorDto {
  @IsString()
  @IsNotEmpty()
  businessName: string;

  @IsString()
  @IsNotEmpty()
  contactName: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  @IsNotEmpty()
  latitude: number;

  @IsNumber()
  @IsNotEmpty()
  longitude: number;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
