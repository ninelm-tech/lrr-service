import { Test, TestingModule } from '@nestjs/testing';
import { TowOperatorController } from './tow-operator.controller';

describe('TowOperatorController', () => {
  let controller: TowOperatorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TowOperatorController],
    }).compile();

    controller = module.get<TowOperatorController>(TowOperatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
