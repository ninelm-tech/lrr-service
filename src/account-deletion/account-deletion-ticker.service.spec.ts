import { AccountDeletionTickerService } from './account-deletion-ticker.service';

describe('AccountDeletionTickerService', () => {
  it('runs both checks on tick, and one failing does not stop the other', async () => {
    const purgeCheck = {
      name: 'purge',
      run: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const mediaRetryCheck = {
      name: 'media-retry',
      run: jest.fn().mockResolvedValue(0),
    };
    const service = new AccountDeletionTickerService(
      purgeCheck as never,
      mediaRetryCheck as never,
    );

    await (service as unknown as { tick: (now?: Date) => Promise<void> }).tick(
      new Date(),
    );

    expect(purgeCheck.run).toHaveBeenCalled();
    expect(mediaRetryCheck.run).toHaveBeenCalled();
  });
});
