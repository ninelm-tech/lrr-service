import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard, ROLES_KEY } from '../auth/guards/roles.guard';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('StaffController', () => {
  let controller: StaffController;
  let staffService: { list: jest.Mock; update: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    staffService = { list: jest.fn(), update: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StaffController],
      providers: [
        { provide: StaffService, useValue: staffService },
        { provide: AuditLogService, useValue: audit },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(StaffController);
  });

  const rolesOf = (handler: object) =>
    new Reflector().get<UserRole[]>(ROLES_KEY, handler as never);

  it('listing is ADMIN + SUPER_ADMIN, never PRODUCT', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rolesOf(StaffController.prototype.list)).toEqual([
      UserRole.ADMIN,
      UserRole.SUPER_ADMIN,
    ]);
  });

  it('editing staff is SUPER_ADMIN only', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rolesOf(StaffController.prototype.update)).toEqual([
      UserRole.SUPER_ADMIN,
    ]);
  });

  it('clamps pagination inputs', async () => {
    staffService.list.mockResolvedValue({ data: [], meta: {} });
    await controller.list(' ada ', '-3', '9999');
    expect(staffService.list).toHaveBeenCalledWith({
      search: 'ada',
      page: 1,
      limit: 100,
    });
  });

  it('audit-logs a role change with before/after and the actor', async () => {
    staffService.update.mockResolvedValue({
      user: { id: 's-1' },
      before: { role: 'PRODUCT' },
      after: { role: 'ADMIN' },
    });

    await controller.update(
      { user: { userId: 'me', role: 'SUPER_ADMIN' } } as never,
      's-1',
      { role: 'ADMIN' },
    );

    expect(staffService.update).toHaveBeenCalledWith(
      's-1',
      { role: 'ADMIN' },
      'me',
    );
    expect(audit.record).toHaveBeenCalledWith({
      category: 'staff_updated',
      message: expect.any(String) as string,
      details: {
        targetId: 's-1',
        before: { role: 'PRODUCT' },
        after: { role: 'ADMIN' },
      },
      actorId: 'me',
    });
  });
});
