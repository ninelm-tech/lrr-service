import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

const req = { user: { userId: 'admin-1' } } as never;

describe('AccountDeletionController', () => {
  let controller: AccountDeletionController;
  let service: { deleteUser: jest.Mock; deleteOperator: jest.Mock };

  beforeEach(async () => {
    service = { deleteUser: jest.fn(), deleteOperator: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountDeletionController],
      providers: [
        { provide: AccountDeletionService, useValue: service },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();
    controller = module.get(AccountDeletionController);
  });

  it('deletes a user with the acting admin as actor', async () => {
    await controller.deleteUser(req, 'user-1');
    expect(service.deleteUser).toHaveBeenCalledWith('user-1', 'admin-1');
  });

  it('deletes an operator with the acting admin as actor', async () => {
    await controller.deleteOperator(req, 'op-1');
    expect(service.deleteOperator).toHaveBeenCalledWith('op-1', 'admin-1');
  });
});
