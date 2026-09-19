import { Test, TestingModule } from '@nestjs/testing';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('RetryMediaDeletionCheck', () => {
  let check: RetryMediaDeletionCheck;
  let prisma: {
    pendingMediaDeletion: { findMany: jest.Mock; delete: jest.Mock };
  };
  let s3Service: { deleteObject: jest.Mock };

  beforeEach(async () => {
    prisma = {
      pendingMediaDeletion: { findMany: jest.fn(), delete: jest.fn() },
    };
    s3Service = { deleteObject: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetryMediaDeletionCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3Service },
      ],
    }).compile();
    check = module.get(RetryMediaDeletionCheck);
  });

  it('clears a row once its S3 object deletes successfully', async () => {
    prisma.pendingMediaDeletion.findMany.mockResolvedValue([
      { id: 'p-1', s3Key: 'key-1' },
    ]);
    s3Service.deleteObject.mockResolvedValue(undefined);

    const cleared = await check.run();

    expect(s3Service.deleteObject).toHaveBeenCalledWith('key-1');
    expect(prisma.pendingMediaDeletion.delete).toHaveBeenCalledWith({
      where: { id: 'p-1' },
    });
    expect(cleared).toBe(1);
  });

  it('leaves a row in place when its S3 delete still fails', async () => {
    prisma.pendingMediaDeletion.findMany.mockResolvedValue([
      { id: 'p-1', s3Key: 'key-1' },
    ]);
    s3Service.deleteObject.mockRejectedValue(new Error('S3 down'));

    const cleared = await check.run();

    expect(prisma.pendingMediaDeletion.delete).not.toHaveBeenCalled();
    expect(cleared).toBe(0);
  });
});
