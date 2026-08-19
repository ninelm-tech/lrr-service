import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  /** Email or phone number — whichever the user remembers. */
  @IsString()
  @IsNotEmpty()
  identifier: string;

  /**
   * Applied immediately if OTP verification is off; ignored (a code is
   * sent instead) if it's on — see AuthService.requestPasswordReset.
   */
  @IsString()
  @MinLength(8)
  newPassword: string;
}
