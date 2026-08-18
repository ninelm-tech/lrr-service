import { formatIssueType, formatStatus, formatJobRef, buildMediaLinksSection } from './rescue-request-formatting';

describe('rescue-request-formatting', () => {
  describe('formatIssueType', () => {
    it('title-cases and replaces the underscore', () => {
      expect(formatIssueType('FLAT_TYRE' as any)).toBe('Flat Tyre');
      expect(formatIssueType('BREAKDOWN' as any)).toBe('Breakdown');
    });
  });

  describe('formatStatus', () => {
    it('title-cases and replaces all underscores', () => {
      expect(formatStatus('WAITING_FOR_DEPOSIT' as any)).toBe('Waiting For Deposit');
      expect(formatStatus('COMPLETED' as any)).toBe('Completed');
    });
  });

  describe('formatJobRef', () => {
    it('uppercases the last 6 characters of the id with a Job # prefix', () => {
      expect(formatJobRef('cabc123def456ghi789')).toBe('Job #GHI789');
    });
  });

  describe('buildMediaLinksSection', () => {
    const originalApiBaseUrl = process.env.API_BASE_URL;
    afterEach(() => {
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
    });

    it('returns an empty string when there are no media items', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      expect(buildMediaLinksSection([])).toBe('');
    });

    it('returns an empty string when API_BASE_URL is not configured', () => {
      delete process.env.API_BASE_URL;
      expect(buildMediaLinksSection([{ id: 'media-1' }])).toBe('');
    });

    it('builds one /media/:id link per item under API_BASE_URL/api/v1', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = buildMediaLinksSection([{ id: 'media-1' }, { id: 'media-2' }]);
      expect(result).toBe(
        '\n\n📎 Photos/Video/Audio:\nhttps://api.lrr.ninelm.com/api/v1/media/media-1\nhttps://api.lrr.ninelm.com/api/v1/media/media-2',
      );
    });
  });
});
