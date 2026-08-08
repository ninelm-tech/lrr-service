import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { S3Service } from './s3.service';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com/object'),
}));

describe('S3Service', () => {
  let service: S3Service;

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        S3Service,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                AWS_REGION: 'eu-west-1',
                S3_BUCKET_NAME: 'lrr-media-test',
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get<S3Service>(S3Service);
  });

  it('uploads media with the correct bucket, key, body, and content type', async () => {
    const buffer = Buffer.from('fake-image-bytes');
    await service.uploadMedia(buffer, 'image/jpeg', 'rescue-requests/req-1/abc.jpg');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'lrr-media-test',
          Key: 'rescue-requests/req-1/abc.jpg',
          Body: buffer,
          ContentType: 'image/jpeg',
        }),
      }),
    );
  });

  it('returns a signed URL for a given key', async () => {
    const url = await service.getSignedUrl('rescue-requests/req-1/abc.jpg', 3600);
    expect(url).toBe('https://signed-url.example.com/object');
  });
});
