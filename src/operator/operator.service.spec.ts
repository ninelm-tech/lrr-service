import { Test, TestingModule } from '@nestjs/testing';
import { TowOperatorService } from './tow-operator.service';

describe('TowOperatorService', () => {
  let service: TowOperatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TowOperatorService],
    }).compile();

    service = module.get<TowOperatorService>(TowOperatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
