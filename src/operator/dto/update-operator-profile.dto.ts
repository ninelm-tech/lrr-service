import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { OperatorType, TruckClass } from '@prisma/client';

export class UpdateOperatorProfileDto {
  @IsString()
  @IsOptional()
  businessName?: string;

  @IsString()
  @IsOptional()
  contactName?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phoneNumber?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsNumber()
  @IsOptional()
  latitude?: number;

  @IsNumber()
  @IsOptional()
  longitude?: number;

  @IsEnum(OperatorType)
  @IsOptional()
  type?: OperatorType;

  @IsNumber()
  @IsOptional()
  serviceRadius?: number;

  @IsArray()
  @IsEnum(TruckClass, { each: true })
  @IsOptional()
  truckClasses?: TruckClass[];
}
