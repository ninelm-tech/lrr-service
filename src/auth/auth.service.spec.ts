import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
    operator: { findFirst: jest.Mock; create: jest.Mock };
    operatorMember: { create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
      operator: { findFirst: jest.fn(), create: jest.fn() },
      operatorMember: { create: jest.fn() },
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

  describe('registerOperator', () => {
    const operatorDto = {
      businessName: 'Acme Towing',
      contactName:  'Jane Doe',
      phoneNumber:  '08012345678',
      email:        'jane@acme.com',
      address:      '1 Test Street',
      latitude:     6.5,
      longitude:    3.4,
      type:         'TOW_TRUCK',
      password:     'temp12345',
    };

    it('throws ConflictException when the phone number is already registered (not just email)', async () => {
      // Simulates a motorist who already has an account with this phone number.
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-customer' });

      await expect(service.registerOperator(operatorDto)).rejects.toThrow(
        'Email or phone number already registered',
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates the user, operator, and owning operatorMember on success', async () => {
      (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.operator.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue({ id: 'user-1', role: 'OPERATOR' });
      (prisma.operator.create as jest.Mock).mockResolvedValue({ id: 'operator-1' });
      (prisma.operatorMember.create as jest.Mock).mockResolvedValue({ id: 'member-1' });

      const result = await service.registerOperator(operatorDto);

      expect(prisma.user.create).toHaveBeenCalled();
      expect(prisma.operator.create).toHaveBeenCalled();
      expect(prisma.operatorMember.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', operatorId: 'operator-1', role: 'OWNER' },
      });
      expect(result).toEqual({
        user: { id: 'user-1', role: 'OPERATOR' },
        operator: { id: 'operator-1' },
        operatorMember: { id: 'member-1' },
      });
    });
  });
});
