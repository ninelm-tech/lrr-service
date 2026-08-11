import { IsNotEmpty, IsString } from 'class-validator';

export class SaveBankDetailsDto {
  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  bankName: string;

  @IsString()
  @IsNotEmpty()
  accountNumber: string;
}
