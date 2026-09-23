import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OperatorService } from './operator.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { OtpService } from '../otp/otp.service';
import { TruckClass } from '@prisma/client';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { OperatorMembershipService } from './operator-membership.service';

describe('OperatorService', () => {
  let service: OperatorService;
  let prisma: {
    operator: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    dispatchOffer: { findMany: jest.Mock };
    rating: { aggregate: jest.Mock; groupBy: jest.Mock };
    user: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    operatorMember: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
    phoneVerification: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let paystackMock: {
    resolveAccountNumber: jest.Mock;
    createTransferRecipient: jest.Mock;
  };
  let otpService: { findValidTokenRow: jest.Mock };
  let operatorMembershipService: { lockActiveMembership: jest.Mock };
  const actingUser = { userId: 'user-1', role: 'OPERATOR' };

  beforeEach(async () => {
    prisma = {
      operator: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      dispatchOffer: { findMany: jest.fn().mockResolvedValue([]) },
      rating: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { score: null }, _count: { score: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      operatorMember: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      phoneVerification: { updateMany: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    paystackMock = {
      resolveAccountNumber: jest.fn(),
      createTransferRecipient: jest.fn(),
    };
    otpService = { findValidTokenRow: jest.fn() };
    operatorMembershipService = {
      lockActiveMembership: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaystackService, useValue: paystackMock },
        { provide: OtpService, useValue: otpService },
        {
          provide: OperatorMembershipService,
          useValue: operatorMembershipService,
        },
      ],
    }).compile();

    service = module.get<OperatorService>(OperatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findByUserId', () => {
    it('excludes a deleted operator or a deleted acting user', async () => {
      prisma.operatorMember.findFirst.mockResolvedValue(null);

      await service.findByUserId('user-1');

      expect(prisma.operatorMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            operator: { deletedAt: null },
            user: { deletedAt: null },
          },
        }),
      );
    });
  });

  describe('setIsTest', () => {
    it('flags an operator as a test operator', async () => {
      prisma.operator.update.mockResolvedValue({ id: 'op-1', isTest: true });

      const result = await service.setIsTest('op-1', true);

      expect(prisma.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: { isTest: true },
      });
      expect(result).toEqual({ id: 'op-1', isTest: true });
    });

    it('unflags an operator back to real', async () => {
      prisma.operator.update.mockResolvedValue({ id: 'op-1', isTest: false });

      await service.setIsTest('op-1', false);

      expect(prisma.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: { isTest: false },
      });
    });
  });

  describe('saveBankDetails', () => {
    it('resolves the account, creates a recipient, and saves only display-safe fields', async () => {
      paystackMock.resolveAccountNumber.mockResolvedValue({
        accountName: 'JOHN DOE',
      });
      paystackMock.createTransferRecipient.mockResolvedValue({
        recipientCode: 'RCP_new123',
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        businessName: 'Swift Towing',
      });
      prisma.operator.update.mockResolvedValue({
        id: 'op-1',
        bankName: 'GTBank',
        accountName: 'JOHN DOE',
        accountNumberLast4: '6789',
        paystackRecipientCode: 'RCP_new123',
      });

      const result = await service.saveBankDetails(
        'op-1',
        {
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        },
        actingUser,
      );

      expect(paystackMock.resolveAccountNumber).toHaveBeenCalledWith(
        '0123456789',
        '058',
      );
      expect(paystackMock.createTransferRecipient).toHaveBeenCalledWith({
        accountNumber: '0123456789',
        bankCode: '058',
        accountName: 'JOHN DOE',
        businessName: 'Swift Towing',
      });
      expect(prisma.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: {
          bankName: 'GTBank',
          accountName: 'JOHN DOE',
          accountNumberLast4: '6789',
          paystackRecipientCode: 'RCP_new123',
        },
      });
      expect(result.accountName).toBe('JOHN DOE');
    });

    it('rejects an account number that is not exactly 10 digits (ValidationPipe is not wired up, so this is enforced manually)', async () => {
      await expect(
        service.saveBankDetails(
          'op-1',
          {
            bankCode: '058',
            bankName: 'GTBank',
            accountNumber: '123',
          },
          actingUser,
        ),
      ).rejects.toThrow('accountNumber must be exactly 10 digits');
      expect(paystackMock.resolveAccountNumber).not.toHaveBeenCalled();
    });
  });

  describe('clearBankDetails', () => {
    it('nulls out all stored bank fields', async () => {
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        businessName: 'Swift Towing',
      });
      prisma.operator.update.mockResolvedValue({
        id: 'op-1',
        bankName: null,
        accountName: null,
        accountNumberLast4: null,
        paystackRecipientCode: null,
      });

      await service.clearBankDetails('op-1', actingUser);

      expect(prisma.operator.update).toHaveBeenCalledWith({
        where: { id: 'op-1' },
        data: {
          bankName: null,
          accountName: null,
          accountNumberLast4: null,
          paystackRecipientCode: null,
        },
      });
    });

    it('throws NotFoundException for a nonexistent operator', async () => {
      prisma.operator.findUnique.mockResolvedValue(null);

      await expect(
        service.clearBankDetails('missing', actingUser),
      ).rejects.toThrow('Operator not found');
      expect(prisma.operator.update).not.toHaveBeenCalled();
    });
  });

  describe('deletion locks for operator mutations', () => {
    beforeEach(() => {
      operatorMembershipService.lockActiveMembership.mockRejectedValue(
        new Error('This operator has been deleted.'),
      );
    });

    it('blocks availability updates before writing', async () => {
      await expect(
        service.setAvailability('op-1', true, actingUser),
      ).rejects.toThrow('This operator has been deleted.');

      expect(prisma.operator.update).not.toHaveBeenCalled();
    });

    it('blocks profile updates before reading or writing', async () => {
      await expect(
        service.updateProfile('op-1', {}, actingUser),
      ).rejects.toThrow('This operator has been deleted.');

      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(prisma.operator.update).not.toHaveBeenCalled();
    });

    it('blocks member additions before touching the target user', async () => {
      await expect(
        service.addMember(
          'op-1',
          { userId: 'target-1', role: 'STAFF' },
          actingUser,
        ),
      ).rejects.toThrow('This operator has been deleted.');

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.operatorMember.create).not.toHaveBeenCalled();
    });

    it('blocks member removals before reading the membership', async () => {
      await expect(
        service.removeMember('op-1', 'member-1', actingUser),
      ).rejects.toThrow('This operator has been deleted.');

      expect(prisma.operatorMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.operatorMember.delete).not.toHaveBeenCalled();
    });
  });

  describe('addMember target-user lock', () => {
    it('rejects a missing or deleted target user before creating membership', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.addMember(
          'op-1',
          { userId: 'target-1', role: 'STAFF' },
          actingUser,
        ),
      ).rejects.toThrow(
        'Cannot add this member: account not found or has been deleted.',
      );

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'target-1', deletedAt: null },
        data: { updatedAt: expect.any(Date) },
      });
      expect(prisma.operatorMember.create).not.toHaveBeenCalled();
    });
  });

  describe('getOperatorStats — ratings', () => {
    it('includes averageRating and ratingCount, scoped to ratings received', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([]);
      prisma.rating.aggregate.mockResolvedValue({
        _avg: { score: 4.5 },
        _count: { score: 2 },
      });

      const result = await service.getOperatorStats('op-1');

      expect(prisma.rating.aggregate).toHaveBeenCalledWith({
        where: { operatorId: 'op-1', direction: 'MOTORIST_TO_OPERATOR' },
        _avg: { score: true },
        _count: { score: true },
      });
      expect(result.averageRating).toBe(4.5);
      expect(result.ratingCount).toBe(2);
    });

    it('returns null averageRating and 0 ratingCount for an operator with no ratings', async () => {
      prisma.dispatchOffer.findMany.mockResolvedValue([]);
      prisma.rating.aggregate.mockResolvedValue({
        _avg: { score: null },
        _count: { score: 0 },
      });

      const result = await service.getOperatorStats('op-1');

      expect(result.averageRating).toBeNull();
      expect(result.ratingCount).toBe(0);
    });
  });

  describe('findAndRankCandidates truck-class filtering', () => {
    it('passes a hasSome truckClasses filter into the Prisma query when truckClasses is provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, [
        TruckClass.LOW_BED,
        TruckClass.HIAB,
      ]);

      expect(prisma.operator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            truckClasses: { hasSome: [TruckClass.LOW_BED, TruckClass.HIAB] },
          }),
        }),
      );
    });

    it('omits the truckClasses filter entirely when not provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });

    it('omits the truckClasses filter when given an empty array', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, []);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });
  });

  describe('findAndRankCandidates isTest partitioning', () => {
    it('defaults to non-test operators when isTest is omitted', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0);

      expect(prisma.operator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isTest: false }),
        }),
      );
    });

    it('filters to isTest operators only when isTest is true', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(
        6.5,
        3.4,
        [],
        0,
        undefined,
        undefined,
        true,
      );

      expect(prisma.operator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isTest: true }),
        }),
      );
    });
  });

  describe('create() truckClasses server-side enforcement', () => {
    const baseDto = (): CreateOperatorDto => ({
      email: 'op@example.com',
      password: 'password123',
      name: 'Jane Doe',
      businessName: 'Acme Towing',
      contactName: 'Jane Doe',
      phoneNumber: '+2348012345678',
      businessPhoneNumber: '+2348012345678',
      address: '1 Test Street',
      latitude: 6.5,
      longitude: 3.4,
      truckClasses: [TruckClass.LOW_BED],
      phoneVerificationToken: 'valid-token',
    });

    it('throws BadRequestException when truckClasses is missing', async () => {
      const dto = baseDto();
      delete (dto as Partial<CreateOperatorDto>).truckClasses;

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when truckClasses is an empty array', async () => {
      const dto = { ...baseDto(), truckClasses: [] };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when truckClasses contains an invalid value', async () => {
      const dto = {
        ...baseDto(),
        truckClasses: ['NOT_A_REAL_CLASS'] as unknown as TruckClass[],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when the business phone number is already a registered customer account', async () => {
      const dto = {
        ...baseDto(),
        phoneNumber: '+2348012345678',
        businessPhoneNumber: '+2348099999999',
      };
      prisma.user.findUnique.mockResolvedValue(null); // existingByPhone, existingByEmail — clear
      prisma.operator.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue({
        id: 'existing-customer',
      }); // business phone vs User check
      otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' }); // fresh signup now requires a token too

      await expect(service.create(dto)).rejects.toThrow(
        'This business phone number is already registered as a customer account. Use a different number for your business line.',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('existing-customer upgrade path', () => {
      it('fresh number: requires and atomically claims a phone-verification token, same as the upgrade path', async () => {
        prisma.user.findUnique.mockResolvedValue(null); // existingByPhone, existingByEmail
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
        prisma.$transaction.mockImplementation(
          (fn: (client: typeof prisma) => unknown) => fn(prisma),
        );
        prisma.phoneVerification.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 1 });
        prisma.user.create.mockResolvedValue({ id: 'u-new' });
        prisma.operator.create.mockResolvedValue({ id: 'op-new' });
        prisma.operatorMember.create.mockResolvedValue({});

        await service.create(baseDto());

        expect(prisma.user.create).toHaveBeenCalled();
        expect(otpService.findValidTokenRow).toHaveBeenCalledWith(
          baseDto().phoneNumber,
          'valid-token',
        );
        expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'pv-fresh',
            consumedAt: null,
            tokenExpiresAt: { gt: expect.any(Date) },
          },
          data: { consumedAt: expect.any(Date) },
        });
      });

      it('fresh number: two concurrent submissions with the same token — the second finds the claim already taken', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
        prisma.$transaction.mockImplementation(
          (fn: (client: typeof prisma) => unknown) => fn(prisma),
        );
        // Simulates the row a first, already-committed concurrent call already claimed.
        prisma.phoneVerification.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 0 });

        await expect(service.create(baseDto())).rejects.toThrow(
          'Verify your phone number first.',
        );
        expect(prisma.user.create).not.toHaveBeenCalled();
      });

      it('fresh number without a token: rejected before the transaction starts', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        const dto = baseDto();
        delete (dto as Partial<CreateOperatorDto>).phoneVerificationToken;

        await expect(service.create(dto)).rejects.toThrow(
          'Verify your phone number first.',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('fresh number with an invalid/expired token: rejected before the transaction starts', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue(null);

        await expect(service.create(baseDto())).rejects.toThrow(
          'Verify your phone number first.',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('signup with no email: skips the email-duplicate lookup entirely and succeeds', async () => {
        const dto = baseDto();
        delete (dto as Partial<CreateOperatorDto>).email;
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.email)
              throw new Error('email lookup must not run when email is absent');
            return Promise.resolve(null); // phone lookup
          },
        );
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
        prisma.$transaction.mockImplementation(
          (fn: (client: typeof prisma) => unknown) => fn(prisma),
        );
        prisma.phoneVerification.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 1 });
        prisma.user.create.mockResolvedValue({ id: 'u-new' });
        prisma.operator.create.mockResolvedValue({ id: 'op-new' });
        prisma.operatorMember.create.mockResolvedValue({});

        await service.create(dto);

        expect(prisma.user.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ email: undefined }),
          }),
        );
      });

      it('email belongs to a different existing user than the phone match: conflict, not misattributed', async () => {
        const dto = baseDto();
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.phoneNumber) return Promise.resolve(null); // no phone match
            if (where.email) return Promise.resolve({ id: 'other-user' }); // different account owns this email
            return Promise.resolve(null);
          },
        );

        await expect(service.create(dto)).rejects.toThrow(
          'Email or phone number already registered',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('existing customer with a valid token: reuses the User row transactionally, atomically claims the token', async () => {
        const dto = { ...baseDto(), phoneVerificationToken: 'valid-token' };
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.phoneNumber)
              return Promise.resolve({
                id: 'existing-customer',
                role: 'CUSTOMER',
                phoneNumber: dto.phoneNumber,
                email: 'old@example.com',
              });
            if (where.email)
              return Promise.resolve({
                id: 'existing-customer',
                role: 'CUSTOMER',
              }); // same account — not a conflict
            return Promise.resolve(null);
          },
        );
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue({
          id: 'pv-1',
        });
        prisma.$transaction.mockImplementation(
          (fn: (client: typeof prisma) => unknown) => fn(prisma),
        );
        prisma.phoneVerification.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 1 });
        prisma.user.update.mockResolvedValue({
          id: 'existing-customer',
        });
        prisma.operator.create.mockResolvedValue({
          id: 'op-new',
        });
        prisma.operatorMember.create.mockResolvedValue({});

        await service.create(dto);

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'existing-customer' },
            data: expect.objectContaining({ role: 'OPERATOR' }),
          }),
        );
        expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'pv-1',
            consumedAt: null,
            tokenExpiresAt: { gt: expect.any(Date) },
          },
          data: { consumedAt: expect.any(Date) },
        });
      });

      it('existing customer: two concurrent upgrade submissions with the same token — the second finds the claim already taken', async () => {
        const dto = { ...baseDto(), phoneVerificationToken: 'valid-token' };
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.phoneNumber)
              return Promise.resolve({
                id: 'existing-customer',
                role: 'CUSTOMER',
                phoneNumber: dto.phoneNumber,
                email: 'old@example.com',
              });
            if (where.email)
              return Promise.resolve({
                id: 'existing-customer',
                role: 'CUSTOMER',
              });
            return Promise.resolve(null);
          },
        );
        prisma.operator.findUnique.mockResolvedValue(null);
        prisma.user.findFirst.mockResolvedValue(null);
        otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
        prisma.$transaction.mockImplementation(
          (fn: (client: typeof prisma) => unknown) => fn(prisma),
        );
        // Simulates the row a first, already-committed concurrent submission already claimed.
        prisma.phoneVerification.updateMany = jest
          .fn()
          .mockResolvedValue({ count: 0 });

        await expect(service.create(dto)).rejects.toThrow(
          'This number belongs to an existing account — verify your number first.',
        );
        expect(prisma.user.update).not.toHaveBeenCalled();
      });

      it('existing customer without a valid token: blocked with the specific error, transaction never starts', async () => {
        const dto = baseDto();
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.phoneNumber)
              return Promise.resolve({
                id: 'existing-customer',
                role: 'CUSTOMER',
                phoneNumber: dto.phoneNumber,
              });
            return Promise.resolve(null);
          },
        );
        otpService.findValidTokenRow.mockResolvedValue(null);

        await expect(service.create(dto)).rejects.toThrow('verify your number');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('existing operator/admin on that phone: hard block, no OTP path', async () => {
        const dto = baseDto();
        prisma.user.findUnique.mockImplementation(
          ({ where }: { where: Record<string, unknown> }) => {
            if (where.phoneNumber)
              return Promise.resolve({
                id: 'existing-op',
                role: 'OPERATOR',
                phoneNumber: dto.phoneNumber,
              });
            return Promise.resolve(null);
          },
        );

        await expect(service.create(dto)).rejects.toThrow(
          'Email or phone number already registered',
        );
        expect(otpService.findValidTokenRow).not.toHaveBeenCalled();
      });
    });
  });
});
