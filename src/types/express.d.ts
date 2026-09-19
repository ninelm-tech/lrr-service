import 'express';

declare module 'express' {
  export interface Request {
    user: {
      userId: string;
      phone?: string;
      role?: string;
    };
  }
}
