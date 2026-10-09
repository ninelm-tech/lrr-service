import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard, ROLES_KEY } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';

describe('OperatorController', () => {
  let controller: OperatorController;
  let operatorService: { setIsTest: jest.Mock; adminCreate: jest.Mock };

  beforeEach(async () => {
    operatorService = { setIsTest: jest.fn(), adminCreate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OperatorController],
      providers: [
        {
          provide: OperatorService,
          useValue: operatorService,
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
});
