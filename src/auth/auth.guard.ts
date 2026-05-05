import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = authHeader.replace('Bearer ', '');
    try {
      const payload = this.jwtService.verify(token);
      request.user = {
        userId: payload.sub,
        phone: payload.phoneNumber,
        role: payload.role,
      };
      return true;
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
