import { Controller, Get, NotFoundException, Param, Redirect } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

@Controller('media')
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  @Get(':mediaId')
  @Redirect()
  async redirectToMedia(@Param('mediaId') mediaId: string) {
    const media = await this.prisma.requestMedia.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');

    const url = await this.s3Service.getSignedUrl(media.s3Key, SIGNED_URL_EXPIRY_SECONDS);
    return { url, statusCode: 302 };
  }
}
