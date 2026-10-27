import { IsOptional, IsString } from 'class-validator';

/**
 * Body for manual-arrived/manual-done when the assigned operator is
 * WhatsApp-enabled — the controller requires `reason` to be a non-empty
 * string in that case specifically (there is no global ValidationPipe in
 * this app, so that check happens by hand in the controller, not here).
 * For a non-WhatsApp operator's job, `reason` is not required at all.
 */
export class ManualOverrideDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
