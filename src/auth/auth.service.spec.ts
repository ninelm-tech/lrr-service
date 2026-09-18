import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
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
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('mock-jwt-token') },
        },
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

  describe('login', () => {
    it('succeeds via email', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u-1',
        email: 'ada@example.com',
        phoneNumber: null,
        passwordHash: await bcrypt.hash('correct-password', 10),
        name: 'Ada',
        role: 'OPERATOR',
      });

      const result = await service.login('ada@example.com', 'correct-password');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'ada@example.com' },
      });
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.user).toEqual({
        id: 'u-1',
        email: 'ada@example.com',
        name: 'Ada',
        role: 'OPERATOR',
      });
    });

    it('succeeds via phone when the identifier is not a registered email', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // email lookup misses
        .mockResolvedValueOnce({
          id: 'u-1',
          email: null,
          phoneNumber: '+2348012345678',
          passwordHash: await bcrypt.hash('correct-password', 10),
          name: 'Ada',
          role: 'OPERATOR',
        });

      const result = await service.login('+2348012345678', 'correct-password');

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
        where: { phoneNumber: '+2348012345678' },
      });
      expect(result.user.email).toBeNull();
    });

    it('succeeds via phone typed in local format (0801...) — the stored value is E.164', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // email lookup misses
        .mockResolvedValueOnce({
          id: 'u-1',
          email: null,
          phoneNumber: '+2348012345678',
          passwordHash: await bcrypt.hash('correct-password', 10),
          name: 'Ada',
          role: 'OPERATOR',
        });

      const result = await service.login('08012345678', 'correct-password');

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
        where: { phoneNumber: '+2348012345678' },
      });
      expect(result.user.role).toBe('OPERATOR');
    });

    it('rejects cleanly (no crash) when the identifier is neither a known email nor a valid phone shape', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null); // email lookup misses

      await expect(
        service.login('not-an-email-or-phone', 'whatever'),
      ).rejects.toThrow('Invalid email or password');
      // Only the email lookup ran — normalizePhone threw before a second
      // findUnique could be attempted, and that throw was caught, not
      // left to escape as an unhandled 500.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('rejects a wrong password on either identifier', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u-1',
        email: 'ada@example.com',
        passwordHash: await bcrypt.hash('correct-password', 10),
        role: 'OPERATOR',
      });

      await expect(
        service.login('ada@example.com', 'wrong-password'),
      ).rejects.toThrow('Invalid email or password');
    });

    it('rejects when no account matches either lookup', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login('nobody@example.com', 'whatever'),
      ).rejects.toThrow('Invalid email or password');
    });
  });

  describe('requestPasswordReset', () => {
    it('rejects a password shorter than 8 characters', async () => {
      await expect(
        service.requestPasswordReset('ada@example.com', 'short'),
      ).rejects.toThrow('at least 8 characters');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
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

    it('falls back to phone lookup (already E.164) when the identifier does not match an email', async () => {
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

    it('normalizes a phone typed in local format (0801...) before the phone lookup', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // email lookup misses
        .mockResolvedValueOnce({
          id: 'u-1',
          phoneNumber: '+2348012345678',
          passwordHash: 'hashed',
        });

      await service.requestPasswordReset('08012345678', 'newpassword1');

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
        where: { phoneNumber: '+2348012345678' },
      });
      expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
        '+2348012345678',
      );
    });

    it('returns the generic message with no crash when the identifier is neither a known email nor a valid phone shape', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null); // email lookup misses

      const result = await service.requestPasswordReset(
        'not-an-email-or-phone',
        'newpassword1',
      );

      expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
      expect(result.otpRequired).toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
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

  describe('resetPasswordWithCode', () => {
    it('rejects a password shorter than 8 characters', async () => {
      await expect(
        service.resetPasswordWithCode('+2348012345678', '123456', 'short'),
      ).rejects.toThrow('at least 8 characters');
      expect(otpService.verifyCode).not.toHaveBeenCalled();
    });

    it('fails to find a code when none was ever sent', async () => {
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

    it('verifies the code, atomically claims the token, and updates the password', async () => {
      otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
      otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
      const tx = {
        phoneVerification: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

      expect(tx.phoneVerification.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'pv-1',
          consumedAt: null,
          tokenExpiresAt: { gt: expect.any(Date) },
        },
        data: { consumedAt: expect.any(Date) },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { passwordHash: expect.any(String) },
      });
      expect(result.message).toContain('Password updated');
    });

    it('rejects when the claim matches zero rows — already consumed or expired since verify', async () => {
      otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
      otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
      const tx = {
        phoneVerification: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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

    it('rejects a second call with the same already-consumed code — the concrete replay this fixes', async () => {
      otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
      otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
      const tx = {
        // Simulates the row a first, already-succeeded call already claimed.
        phoneVerification: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
