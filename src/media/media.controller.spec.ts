import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MediaController } from './media.controller';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('MediaController', () => {
  let controller: MediaController;
  let prisma: { requestMedia: { findUnique: jest.Mock } };
  let s3: { getSignedUrl: jest.Mock };

  beforeEach(async () => {
    prisma = { requestMedia: { findUnique: jest.fn() } };
    s3 = { getSignedUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3 },
      ],
    }).compile();

    controller = module.get<MediaController>(MediaController);
  });

  it('redirects to a freshly generated signed URL for an existing media item', async () => {
    prisma.requestMedia.findUnique.mockResolvedValue({
      id: 'media-1',
      s3Key: 'rescue-requests/req-1/abc.jpg',
    });
    s3.getSignedUrl.mockResolvedValue('https://signed.example.com/abc.jpg');

    const result = await controller.redirectToMedia('media-1');

    expect(prisma.requestMedia.findUnique).toHaveBeenCalledWith({ where: { id: 'media-1' } });
    expect(s3.getSignedUrl).toHaveBeenCalledWith('rescue-requests/req-1/abc.jpg', expect.any(Number));
    expect(result).toEqual({ url: 'https://signed.example.com/abc.jpg', statusCode: 302 });
  });

  it('throws NotFoundException for a nonexistent media ID', async () => {
    prisma.requestMedia.findUnique.mockResolvedValue(null);

    await expect(controller.redirectToMedia('missing-id')).rejects.toThrow(NotFoundException);
  });
});
