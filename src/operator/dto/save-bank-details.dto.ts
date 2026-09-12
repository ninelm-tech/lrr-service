import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class SaveBankDetailsDto {
  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsString()
  @IsNotEmpty()
  bankName: string;

  /** Nigerian NUBAN account numbers are exactly 10 digits. */
  @IsString()
  @Matches(/^\d{10}$/)
  accountNumber: string;
}
