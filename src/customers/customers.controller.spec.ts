import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard, ROLES_KEY } from '../auth/guards/roles.guard';
import { AuditLogService } from '../audit-log/audit-log.service';

describe('CustomersController', () => {
  let controller: CustomersController;
  let customersService: { list: jest.Mock; update: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    customersService = { list: jest.fn(), update: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        { provide: CustomersService, useValue: customersService },
        { provide: AuditLogService, useValue: audit },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(CustomersController);
  });

  it('is ADMIN + SUPER_ADMIN only, never PRODUCT', () => {
    expect(
      new Reflector().get<UserRole[]>(ROLES_KEY, CustomersController),
    ).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
  });

  it('audit-logs field names only, never the personal values', async () => {
    customersService.update.mockResolvedValue({
      customer: { id: 'c-1' },
      changedFields: ['name', 'email'],
    });

    await controller.update(
      { user: { userId: 'admin-1', role: 'ADMIN' } } as never,
      'c-1',
      { name: 'Secret Name', email: 'secret@example.com' },
    );

    expect(audit.record).toHaveBeenCalledWith({
      category: 'customer_updated',
      message: expect.any(String) as string,
      details: { targetId: 'c-1', changedFields: ['name', 'email'] },
      actorId: 'admin-1',
    });
    const logged = JSON.stringify(audit.record.mock.calls);
    expect(logged).not.toContain('Secret Name');
    expect(logged).not.toContain('secret@example.com');
  });
});
