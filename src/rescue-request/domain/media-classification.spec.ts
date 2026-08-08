import { MediaType } from '@prisma/client';
import { classifyMediaType, getExtensionFromContentType } from './media-classification';

describe('classifyMediaType', () => {
  it('classifies image/* as IMAGE', () => {
    expect(classifyMediaType('image/jpeg')).toBe(MediaType.IMAGE);
    expect(classifyMediaType('image/png')).toBe(MediaType.IMAGE);
  });

  it('classifies video/* as VIDEO', () => {
    expect(classifyMediaType('video/mp4')).toBe(MediaType.VIDEO);
    expect(classifyMediaType('video/3gpp')).toBe(MediaType.VIDEO);
  });

  it('classifies audio/* as AUDIO', () => {
    expect(classifyMediaType('audio/ogg')).toBe(MediaType.AUDIO);
    expect(classifyMediaType('audio/mpeg')).toBe(MediaType.AUDIO);
  });

  it('returns undefined for unrecognised content types', () => {
    expect(classifyMediaType('application/pdf')).toBeUndefined();
    expect(classifyMediaType('')).toBeUndefined();
  });
});

describe('getExtensionFromContentType', () => {
  it('maps common content types to file extensions', () => {
    expect(getExtensionFromContentType('image/jpeg')).toBe('jpg');
    expect(getExtensionFromContentType('image/png')).toBe('png');
    expect(getExtensionFromContentType('video/mp4')).toBe('mp4');
    expect(getExtensionFromContentType('audio/ogg')).toBe('ogg');
    expect(getExtensionFromContentType('audio/mpeg')).toBe('mp3');
  });

  it('falls back to a generic extension for unrecognised content types', () => {
    expect(getExtensionFromContentType('application/octet-stream')).toBe('bin');
    expect(getExtensionFromContentType('')).toBe('bin');
  });
});
