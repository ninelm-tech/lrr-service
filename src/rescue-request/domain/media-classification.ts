import { MediaType } from '@prisma/client';

export function classifyMediaType(contentType: string): MediaType | undefined {
  if (contentType.startsWith('image/')) return MediaType.IMAGE;
  if (contentType.startsWith('video/')) return MediaType.VIDEO;
  if (contentType.startsWith('audio/')) return MediaType.AUDIO;
  return undefined;
}

const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
};

export function getExtensionFromContentType(contentType: string): string {
  return CONTENT_TYPE_TO_EXTENSION[contentType] ?? 'bin';
}
