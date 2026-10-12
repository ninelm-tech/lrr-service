import { JwtModuleOptions } from '@nestjs/jwt';

/**
 * How long a login token stays valid. The web portal's session cookie
 * (lrr-web `SESSION_MAX_AGE_SECONDS`) must be the same value, so the cookie
 * and the token expire together — keep the two in step.
 *
 * Short on purpose: these tokens carry the user's role and are trusted
 * without a database lookup, and the app moves money.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function buildJwtOptions(secret: string): JwtModuleOptions {
  return {
    secret,
    signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  };
}
