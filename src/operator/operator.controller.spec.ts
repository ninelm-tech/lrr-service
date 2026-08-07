import { Test, TestingModule } from '@nestjs/testing';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('OperatorController', () => {
  let controller: OperatorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OperatorController],
      providers: [
        {
          provide: OperatorService,
          useValue: {},
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
});
