import { Test, TestingModule } from '@nestjs/testing';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { TermiiService } from '../integrations/termii/termii.service';
import { UserRole } from '@prisma/client';

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    user: { findUnique: jest.Mock };
    phoneVerification: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let termiiService: { sendOtp: jest.Mock; verifyOtp: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      phoneVerification: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    termiiService = {
      sendOtp: jest.fn().mockResolvedValue({ pinId: 'pin-1' }),
      verifyOtp: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: TermiiService, useValue: termiiService },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  describe('sendCode', () => {
    it('sends a code and responds required:true for a brand-new phone (no account yet)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.phoneVerification.findMany.mockResolvedValue([]);
      prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('verification code'),
        expect.any(Number),
      );
      expect(prisma.phoneVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ pinId: 'pin-1' }),
        }),
      );
    });

    it('responds required:false, available:false for an existing OPERATOR/ADMIN number, sends nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.OPERATOR,
      });

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: false, available: false });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('sends a code and responds required:true for an existing CUSTOMER number', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.CUSTOMER,
      });
      prisma.phoneVerification.findMany.mockResolvedValue([]); // no recent sends — cooldown/cap clear
      prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('verification code'),
        expect.any(Number),
      );
    });

    it('rejects when the resend cooldown has not elapsed', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.CUSTOMER,
      });
      prisma.phoneVerification.findMany.mockResolvedValue([
        { createdAt: new Date() },
      ]); // sent seconds ago

      await expect(service.sendCode('+2348012345678')).rejects.toThrow('wait');
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('rejects when the per-window send cap is hit', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.CUSTOMER,
      });
      const oldEnoughToClearCooldown = new Date(Date.now() - 120_000);
      prisma.phoneVerification.findMany.mockResolvedValue(
        Array.from({ length: 5 }, () => ({
          createdAt: oldEnoughToClearCooldown,
        })),
      );

      await expect(service.sendCode('+2348012345678')).rejects.toThrow(
        'Too many',
      );
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });
  });

  describe('sendPasswordResetCode', () => {
    it('responds required:false and sends nothing when no account exists for the number', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.sendPasswordResetCode('+2348012345678');

      expect(result).toEqual({ required: false });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('responds required:false and sends nothing when the account has no portal password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.CUSTOMER,
        passwordHash: null,
      });

      const result = await service.sendPasswordResetCode('+2348012345678');

      expect(result).toEqual({ required: false });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('sends a code for any role that has a portal password, not just CUSTOMER', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.OPERATOR,
        passwordHash: 'hashed',
      });
      prisma.phoneVerification.findMany.mockResolvedValue([]);
      prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

      const result = await service.sendPasswordResetCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('password reset code'),
        expect.any(Number),
      );
    });

    it('rejects when the resend cooldown has not elapsed', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.ADMIN,
        passwordHash: 'hashed',
      });
      prisma.phoneVerification.findMany.mockResolvedValue([
        { createdAt: new Date() },
      ]);

      await expect(
        service.sendPasswordResetCode('+2348012345678'),
      ).rejects.toThrow('wait');
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });
  });

  describe('sendLoginCode', () => {
    it('responds required:true and sends nothing for an unknown phone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.sendLoginCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('responds required:true and sends nothing for a non-OPERATOR account — same response either way', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.CUSTOMER,
      });

      const result = await service.sendLoginCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });

    it('sends a code for an OPERATOR account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.OPERATOR,
      });
      prisma.phoneVerification.findMany.mockResolvedValue([]);
      prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

      const result = await service.sendLoginCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).toHaveBeenCalledWith(
        '+2348012345678',
        expect.stringContaining('login code'),
        expect.any(Number),
      );
    });

    it('responds required:true (not a rejection) for an OPERATOR account hitting the resend cooldown — no enumeration signal via thrown errors', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        role: UserRole.OPERATOR,
      });
      prisma.phoneVerification.findMany.mockResolvedValue([
        { createdAt: new Date() }, // sent seconds ago — still within cooldown
      ]);

      const result = await service.sendLoginCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(termiiService.sendOtp).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode', () => {
    it('issues a token on a correct, unexpired code', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1',
        pinId: 'pin-1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60_000),
        verifiedAt: null,
      });
      termiiService.verifyOtp.mockResolvedValue({ verified: true });
      prisma.phoneVerification.update.mockResolvedValue({});

      const result = await service.verifyCode('+2348012345678', '123456');

      expect(termiiService.verifyOtp).toHaveBeenCalledWith('pin-1', '123456');
      expect(result.token).toEqual(expect.any(String));
      expect(prisma.phoneVerification.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pv-1' },
          data: expect.objectContaining({
            verifiedAt: expect.any(Date),
            verificationTokenHash: expect.any(String),
          }),
        }),
      );
    });

    it('rejects a wrong code and increments attempts', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1',
        pinId: 'pin-1',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60_000),
        verifiedAt: null,
      });
      termiiService.verifyOtp.mockResolvedValue({ verified: false });

      await expect(
        service.verifyCode('+2348012345678', '999999'),
      ).rejects.toThrow('Incorrect code');
      expect(prisma.phoneVerification.update).toHaveBeenCalledWith({
        where: { id: 'pv-1' },
        data: { attempts: 1 },
      });
    });

    it('rejects once attempts has reached the max, regardless of expiresAt — without calling Termii', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1',
        pinId: 'pin-1',
        attempts: 5,
        expiresAt: new Date(Date.now() + 60_000),
        verifiedAt: null,
      });

      await expect(
        service.verifyCode('+2348012345678', '123456'),
      ).rejects.toThrow('Too many attempts');
      expect(termiiService.verifyOtp).not.toHaveBeenCalled();
    });

    it('rejects an expired code', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue(null); // query excludes expired rows

      await expect(
        service.verifyCode('+2348012345678', '123456'),
      ).rejects.toThrow('expired');
    });
  });
});
