import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  code: string;
}
