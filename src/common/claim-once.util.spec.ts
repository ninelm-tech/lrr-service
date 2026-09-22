import { claimOnce } from './claim-once.util';

describe('claimOnce', () => {
  it('resolves without throwing when the claim matches exactly one row', async () => {
    const delegate = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };

    await expect(
      claimOnce(
        delegate,
        {
          where: { id: 'row-1', consumedAt: null },
          data: { consumedAt: new Date() },
        },
        new Error('should not be thrown'),
      ),
    ).resolves.toBeUndefined();
  });

  it('passes the where/data through to the delegate unchanged', async () => {
    const delegate = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const args = {
      where: {
        id: 'row-1',
        consumedAt: null,
        tokenExpiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    };

    await claimOnce(delegate, args, new Error('unused'));

    expect(delegate.updateMany).toHaveBeenCalledWith(args);
  });

  it('throws the given error when the claim matches zero rows — already claimed by a concurrent caller', async () => {
    const delegate = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const notClaimed = new Error('Code expired — request a new one.');

    await expect(
      claimOnce(delegate, { where: {}, data: {} }, notClaimed),
    ).rejects.toThrow('Code expired — request a new one.');
  });

  it('throws the given error when the claim matches more than one row — the WHERE was not selective enough to trust', async () => {
    const delegate = { updateMany: jest.fn().mockResolvedValue({ count: 2 }) };
    const notClaimed = new Error('unexpected multi-row claim');

    await expect(
      claimOnce(delegate, { where: {}, data: {} }, notClaimed),
    ).rejects.toThrow('unexpected multi-row claim');
  });

  it('throws the exact error instance passed in, so callers can use any exception class (BadRequestException, UnauthorizedException, ...)', async () => {
    const delegate = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    class CustomException extends Error {}
    const custom = new CustomException('custom failure');

    await expect(
      claimOnce(delegate, { where: {}, data: {} }, custom),
    ).rejects.toBe(custom);
  });
});
