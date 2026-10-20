import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard, ROLES_KEY } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('OperatorController', () => {
  let controller: OperatorController;
  let operatorService: {
    setIsTest: jest.Mock;
    adminCreate: jest.Mock;
    assertCanManageOperator: jest.Mock;
    assertCanOnboardOperator: jest.Mock;
    updateProfile: jest.Mock;
    saveBankDetails: jest.Mock;
    clearBankDetails: jest.Mock;
    setDepositPercent: jest.Mock;
    findByUserId: jest.Mock;
  };
  let auditLogService: { record: jest.Mock };
  let platformConfigService: { getConfig: jest.Mock };
  const req = { user: { userId: 'prod-1', role: 'PRODUCT' } };

  beforeEach(async () => {
    operatorService = {
      setIsTest: jest.fn(),
      adminCreate: jest.fn(),
      // Shared by updateProfile/saveBankDetails/clearBankDetails (member
      // management) and setDepositPercent (same permission as bank
      // details) — resolves by default so existing tests of handlers that
      // don't go through this check are unaffected.
      assertCanManageOperator: jest.fn().mockResolvedValue(undefined),
      assertCanOnboardOperator: jest.fn().mockResolvedValue(undefined),
      updateProfile: jest.fn().mockResolvedValue({ id: 'op-1' }),
      saveBankDetails: jest.fn(),
      clearBankDetails: jest.fn().mockResolvedValue({ id: 'op-1' }),
      setDepositPercent: jest.fn(),
      findByUserId: jest.fn(),
    };
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    platformConfigService = { getConfig: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OperatorController],
      providers: [
        {
          provide: OperatorService,
          useValue: operatorService,
        },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: PlatformConfigService,
          useValue: platformConfigService,
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<OperatorController>(OperatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('setIsTest', () => {
    it('is restricted to SUPER_ADMIN only — unlike status/availability', () => {
      // Guards are overridden to always allow in this suite (above), so
      // this checks the declarative metadata RolesGuard actually reads,
      // rather than re-testing RolesGuard's own enforcement here. The
      // unbound method reference is only used as a lookup key here, never
      // called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setIsTestHandler = OperatorController.prototype.setIsTest;
      const roles = new Reflector().get<UserRole[]>(
        ROLES_KEY,
        setIsTestHandler,
      );
      expect(roles).toEqual([UserRole.SUPER_ADMIN]);
    });

    it('forwards to OperatorService.setIsTest and reports the outcome', async () => {
      operatorService.setIsTest.mockResolvedValue({
        id: 'op-1',
        isTest: true,
      });

      const result = await controller.setIsTest('op-1', true);

      expect(operatorService.setIsTest).toHaveBeenCalledWith('op-1', true);
      expect(result).toEqual({
        message: 'Operator marked as test',
        data: { id: 'op-1', isTest: true },
      });
    });
  });

  describe('adminCreate', () => {
    it('is restricted to ADMIN, SUPER_ADMIN, and PRODUCT', () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = OperatorController.prototype.adminCreate;
      const roles = new Reflector().get<UserRole[]>(ROLES_KEY, handler);
      expect(roles).toEqual(
        expect.arrayContaining([
          UserRole.ADMIN,
          UserRole.SUPER_ADMIN,
          UserRole.PRODUCT,
        ]),
      );
      expect(roles).toHaveLength(3);
    });

    it('forwards to OperatorService.adminCreate and reports the outcome', async () => {
      operatorService.adminCreate.mockResolvedValue({
        user: { id: 'u-new' },
        operator: { id: 'op-new', status: 'ACTIVE' },
        operatorMember: { id: 'om-new' },
      });
      const dto = {
        name: 'Jane Doe',
        businessName: 'Acme Towing',
        contactName: 'Jane Doe',
        phoneNumber: '+2348012345678',
        businessPhoneNumber: '+2348012345679',
        address: '1 Test Street',
        latitude: 6.5,
        longitude: 3.4,
        truckClasses: [],
      } as never;

      const result = await controller.adminCreate(dto);

      expect(operatorService.adminCreate).toHaveBeenCalledWith(dto);
      expect(result).toEqual({
        message: 'Operator onboarded and active.',
        data: { userId: 'u-new', operatorId: 'op-new', status: 'ACTIVE' },
      });
    });
  });

  describe('onboarding mutations (PRODUCT allowed)', () => {
    it('updateProfile uses the onboarding permission check, not the member-management one', async () => {
      await controller.updateProfile(req, 'op-1', {});

      expect(operatorService.assertCanOnboardOperator).toHaveBeenCalledWith(
        req.user,
        'op-1',
      );
      expect(operatorService.assertCanManageOperator).not.toHaveBeenCalled();
    });

    it('updateProfile audit-logs which fields changed (names only, not values)', async () => {
      await controller.updateProfile(req, 'op-1', {
        phoneNumber: '+2348012345678',
        email: undefined,
        address: '1 Secret Street',
      });

      expect(auditLogService.record).toHaveBeenCalledWith({
        category: 'operator_profile_updated',
        message: expect.any(String) as string,
        details: {
          operatorId: 'op-1',
          changedFields: ['phoneNumber', 'address'],
        },
        actorId: 'prod-1',
      });
      const logged = JSON.stringify(auditLogService.record.mock.calls);
      expect(logged).not.toContain('2348012345678');
      expect(logged).not.toContain('Secret Street');
    });

    it('saveBankDetails checks onboarding permission and audit-logs without the account number', async () => {
      operatorService.saveBankDetails.mockResolvedValue({
        id: 'op-1',
        bankName: 'GTBank',
        accountName: 'JOHN DOE',
        accountNumberLast4: '6789',
      });

      await controller.saveBankDetails(req, 'op-1', {
        bankCode: '058',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });

      expect(operatorService.assertCanOnboardOperator).toHaveBeenCalledWith(
        req.user,
        'op-1',
      );
      expect(operatorService.assertCanManageOperator).not.toHaveBeenCalled();
      expect(auditLogService.record).toHaveBeenCalledWith({
        category: 'operator_bank_details_saved',
        message: expect.stringContaining('GTBank') as string,
        details: {
          operatorId: 'op-1',
          bankName: 'GTBank',
          accountNumberLast4: '6789',
        },
        actorId: 'prod-1',
      });
      expect(JSON.stringify(auditLogService.record.mock.calls)).not.toContain(
        '0123456789',
      );
    });

    it('clearBankDetails checks onboarding permission and audit-logs the removal', async () => {
      await controller.clearBankDetails(req, 'op-1');

      expect(operatorService.assertCanOnboardOperator).toHaveBeenCalledWith(
        req.user,
        'op-1',
      );
      expect(auditLogService.record).toHaveBeenCalledWith({
        category: 'operator_bank_details_cleared',
        message: expect.any(String) as string,
        details: { operatorId: 'op-1' },
        actorId: 'prod-1',
      });
    });

    it('does not audit-log when the permission check rejects', async () => {
      operatorService.assertCanOnboardOperator.mockRejectedValue(
        new Error('nope'),
      );

      await expect(
        controller.saveBankDetails(req, 'op-1', {
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        }),
      ).rejects.toThrow('nope');
      expect(operatorService.saveBankDetails).not.toHaveBeenCalled();
      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('getMyOperator', () => {
    it('includes the platform-wide default deposit percent alongside the operator record', async () => {
      const operator = { id: 'op-1', depositPercentOverride: null };
      operatorService.findByUserId.mockResolvedValue(operator);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 20,
        dispatchWindowMinutes: 5,
        dispatchBatchSize: 3,
        quoteCollectionMinutes: 10,
        disputeAlertPhoneNumbers: [],
        newRequestAlertPhoneNumbers: [],
        testCustomerPhoneNumbers: [],
      });
      const req = { user: { userId: 'user-1', role: 'OPERATOR' } } as never;

      const result = await controller.getMyOperator(req);

      expect(operatorService.findByUserId).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({
        data: operator,
        platformDefaultDepositPercent: 20,
      });
    });
  });

  describe('setDepositPercent', () => {
    it('forwards to OperatorService.setDepositPercent with the body and the whole acting user (role included)', async () => {
      operatorService.setDepositPercent = jest.fn().mockResolvedValue({
        id: 'op-1',
        depositPercentOverride: 25,
      });
      const req = { user: { userId: 'admin-1', role: 'ADMIN' } } as never;

      const result = await controller.setDepositPercent(req, 'op-1', {
        depositPercentOverride: 25,
      });

      expect(operatorService.assertCanManageOperator).toHaveBeenCalledWith(
        { userId: 'admin-1', role: 'ADMIN' },
        'op-1',
      );
      expect(operatorService.setDepositPercent).toHaveBeenCalledWith(
        'op-1',
        25,
        { userId: 'admin-1', role: 'ADMIN' },
      );
      expect(result).toEqual({
        message: 'Deposit percentage updated',
        data: { id: 'op-1', depositPercentOverride: 25 },
      });
    });
  });
});
