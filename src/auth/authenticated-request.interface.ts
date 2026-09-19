import { Request } from 'express';
import { UserRole } from '@prisma/client';

/**
 * The shape AuthGuard puts on `request.user` after verifying the JWT.
 * Plain `Request` types `.user` as `any`, which is how a typo like
 * `req.user.usrId` would slip past the compiler — this exists so the
 * handful of controllers that need the caller's identity (e.g. for an
 * audit log entry) get it type-checked instead.
 */
export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    phone?: string;
    role: UserRole;
  };
}
