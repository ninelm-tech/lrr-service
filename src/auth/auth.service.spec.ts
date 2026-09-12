import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let otpService: {
    sendPasswordResetCode: jest.Mock;
    verifyCode: jest.Mock;
    findValidTokenRow: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };
    otpService = {
      sendPasswordResetCode: jest.fn(),
      verifyCode: jest.fn(),
      findValidTokenRow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: OtpService, useValue: otpService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createStaff', () => {
    it('creates a user with the given role and a hashed password', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'staff@example.com',
        name: 'New Staff',
        role: 'ADMIN',
      });

      const result = await service.createStaff({
        email: 'staff@example.com',
        name: 'New Staff',
        role: 'ADMIN',
        temporaryPassword: 'temp12345',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'staff@example.com',
          name: 'New Staff',
          role: 'ADMIN',
          passwordHash: expect.any(String),
        }),
      });
      expect(result).toEqual({
        id: 'user-1',
        email: 'staff@example.com',
        name: 'New Staff',
        role: 'ADMIN',
      });
    });

    it('throws ConflictException if the email is already registered', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'existing-1',
      });

      await expect(
        service.createStaff({
          email: 'taken@example.com',
          name: 'X',
          role: 'ADMIN' as any,
          temporaryPassword: 'temp12345',
        }),
      ).rejects.toThrow('Email already registered');
    });
  });

  describe('requestPasswordReset', () => {
    it('rejects a password shorter than 8 characters regardless of flag state', async () => {
      await expect(
        service.requestPasswordReset('ada@example.com', 'short'),
      ).rejects.toThrow('at least 8 characters');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    describe('with the flag off (default) — resets immediately, no verification', () => {
      it('resolves by email, updates the password directly, and reports otpRequired:false', async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
          id: 'u-1',
          email: 'ada@example.com',
          passwordHash: 'old-hash',
        });

        const result = await service.requestPasswordReset(
          'ada@example.com',
          'newpassword1',
        );

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { email: 'ada@example.com' },
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: 'u-1' },
          data: { passwordHash: expect.any(String) },
        });
        expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
        expect(result).toEqual({
          message: 'Password updated. You can now log in.',
          otpRequired: false,
        });
      });

      it('falls back to phone lookup when the identifier does not match an email', async () => {
        prisma.user.findUnique
          .mockResolvedValueOnce(null) // email lookup misses
          .mockResolvedValueOnce({
            id: 'u-1',
            phoneNumber: '+2348012345678',
            passwordHash: 'old-hash',
          });

        await service.requestPasswordReset('+2348012345678', 'newpassword1');

        expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
          where: { phoneNumber: '+2348012345678' },
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: 'u-1' },
          data: { passwordHash: expect.any(String) },
        });
      });

      it('no-ops (but still reports success) when no account matches', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        const result = await service.requestPasswordReset(
          'nobody@example.com',
          'newpassword1',
        );

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(result.otpRequired).toBe(false);
      });

      it('no-ops when the account has no portal password', async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
          id: 'u-1',
          passwordHash: null,
        });

        await service.requestPasswordReset('ada@example.com', 'newpassword1');

        expect(prisma.user.update).not.toHaveBeenCalled();
      });
    });

    describe('with the flag on — sends a code, never resets directly', () => {
      beforeEach(() => {
        (service as any).otpPasswordResetEnabled = true; // OTP Authentication template approved
      });

      it('resolves by email first, sends the code, ignores newPassword, and reports otpRequired:true', async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
          id: 'u-1',
          email: 'ada@example.com',
          phoneNumber: '+2348012345678',
          passwordHash: 'hashed',
        });

        const result = await service.requestPasswordReset(
          'ada@example.com',
          'newpassword1',
        );

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { email: 'ada@example.com' },
        });
        expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
          '+2348012345678',
        );
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(result).toEqual({
          message:
            "If an account exists, we've sent a reset code to its registered phone number.",
          otpRequired: true,
        });
      });

      it('falls back to phone lookup when the identifier does not match an email', async () => {
        prisma.user.findUnique
          .mockResolvedValueOnce(null) // email lookup misses
          .mockResolvedValueOnce({
            id: 'u-1',
            phoneNumber: '+2348012345678',
            passwordHash: 'hashed',
          });

        await service.requestPasswordReset('+2348012345678', 'newpassword1');

        expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
          where: { phoneNumber: '+2348012345678' },
        });
        expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
          '+2348012345678',
        );
      });

      it('returns the same generic message and sends nothing when no account matches', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        const result = await service.requestPasswordReset(
          'nobody@example.com',
          'newpassword1',
        );

        expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
        expect(result.message).toContain("we've sent a reset code");
      });

      it('returns the same generic message and sends nothing when the account has no portal password', async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
          id: 'u-1',
          phoneNumber: '+2348012345678',
          passwordHash: null,
        });

        const result = await service.requestPasswordReset(
          'ada@example.com',
          'newpassword1',
        );

        expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
        expect(result.message).toContain("we've sent a reset code");
      });
    });
  });

  describe('resetPasswordWithCode', () => {
    it('rejects a password shorter than 8 characters', async () => {
      await expect(
        service.resetPasswordWithCode('+2348012345678', '123456', 'short'),
      ).rejects.toThrow('at least 8 characters');
      expect(otpService.verifyCode).not.toHaveBeenCalled();
    });

    it('fails to find a code when the flag was off at request time (nothing was ever sent)', async () => {
      otpService.verifyCode.mockRejectedValue(
        new Error('Code expired or not found — request a new one.'),
      );

      await expect(
        service.resetPasswordWithCode(
          '+2348012345678',
          '123456',
          'newpassword1',
        ),
      ).rejects.toThrow('Code expired or not found');
    });

    describe('with the flag on', () => {
      beforeEach(() => {
        (service as any).otpPasswordResetEnabled = true; // OTP Authentication template approved
      });

      it('verifies the code, consumes the token, and updates the password', async () => {
        otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
        const tx = {
          phoneVerification: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'pv-1',
              consumedAt: null,
              tokenExpiresAt: new Date(Date.now() + 60_000),
            }),
            update: jest.fn(),
          },
          user: {
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: 'u-1', passwordHash: 'old-hash' }),
            update: jest.fn(),
          },
        };
        prisma.$transaction.mockImplementation((cb: any) => cb(tx));

        const result = await service.resetPasswordWithCode(
          '+2348012345678',
          '123456',
          'newpassword1',
        );

        expect(otpService.verifyCode).toHaveBeenCalledWith(
          '+2348012345678',
          '123456',
        );
        expect(tx.phoneVerification.update).toHaveBeenCalledWith({
          where: { id: 'pv-1' },
          data: { consumedAt: expect.any(Date) },
        });
        expect(tx.user.update).toHaveBeenCalledWith({
          where: { id: 'u-1' },
          data: { passwordHash: expect.any(String) },
        });
        expect(result.message).toContain('Password updated');
      });

      it('rejects when the token was already consumed between verify and the transaction', async () => {
        otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
        const tx = {
          phoneVerification: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'pv-1',
              consumedAt: new Date(),
              tokenExpiresAt: new Date(Date.now() + 60_000),
            }),
            update: jest.fn(),
          },
          user: { findUnique: jest.fn(), update: jest.fn() },
        };
        prisma.$transaction.mockImplementation((cb: any) => cb(tx));

        await expect(
          service.resetPasswordWithCode(
            '+2348012345678',
            '123456',
            'newpassword1',
          ),
        ).rejects.toThrow('expired');
        expect(tx.user.update).not.toHaveBeenCalled();
      });

      it('rejects when no valid token row is found', async () => {
        otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
        otpService.findValidTokenRow.mockResolvedValue(null);

        await expect(
          service.resetPasswordWithCode(
            '+2348012345678',
            '123456',
            'newpassword1',
          ),
        ).rejects.toThrow('expired');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });
  });
});
