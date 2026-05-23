import { Test, TestingModule } from '@nestjs/testing';
import { OperatorController } from './operator.controller';

describe('OperatorController', () => {
  let controller: OperatorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OperatorController],
      providers: [
        {
          provide: 'OperatorService',
          useValue: {},
        },
      ],
    })
      .overrideProvider('OperatorService')
      .useValue({})
      .compile();

    controller = module.get<OperatorController>(OperatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
