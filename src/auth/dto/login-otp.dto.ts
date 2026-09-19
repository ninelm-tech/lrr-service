import { IsNotEmpty, IsString, Length } from 'class-validator';

export class SendLoginCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}

export class VerifyLoginCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
