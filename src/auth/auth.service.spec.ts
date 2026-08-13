import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createStaff', () => {
    it('creates a user with the given role and a hashed password', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({
        id: 'user-1', email: 'staff@example.com', name: 'New Staff', role: 'ADMIN',
      });

      const result = await service.createStaff({
        email: 'staff@example.com', name: 'New Staff', role: 'ADMIN' as any, temporaryPassword: 'temp12345',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'staff@example.com',
          name: 'New Staff',
          role: 'ADMIN',
          passwordHash: expect.any(String),
        }),
      });
      expect(result).toEqual({ id: 'user-1', email: 'staff@example.com', name: 'New Staff', role: 'ADMIN' });
    });

    it('throws ConflictException if the email is already registered', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'existing-1' });

      await expect(
        service.createStaff({ email: 'taken@example.com', name: 'X', role: 'ADMIN' as any, temporaryPassword: 'temp12345' }),
      ).rejects.toThrow('Email already registered');
    });
  });
});
