import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdatePlatformConfigDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  serviceFeePercent?: number;

  @IsNumber()
  @Min(10)
  @Max(50)
  @IsOptional()
  depositPercent?: number;

  @IsInt()
  @Min(1)
  @Max(60)
  @IsOptional()
  dispatchWindowMinutes?: number;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  dispatchBatchSize?: number;

  @IsInt()
  @Min(1)
  @Max(60)
  @IsOptional()
  quoteCollectionMinutes?: number;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  disputeAlertPhoneNumbers?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  testCustomerPhoneNumbers?: string[];

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  newRequestAlertPhoneNumbers?: string[];
}
