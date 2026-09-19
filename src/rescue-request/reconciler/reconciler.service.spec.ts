import { ReconcilerService } from './reconciler.service';
import { ReconcilerCheck } from './reconciler-check.interface';

const check = (name: string, impl: () => Promise<number>): ReconcilerCheck => ({
  name,
  run: impl,
});

describe('ReconcilerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs every check', async () => {
    const a = jest.fn().mockResolvedValue(0);
    const b = jest.fn().mockResolvedValue(0);
    const service = new ReconcilerService([check('a', a), check('b', b)]);

    await service.tick();

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('keeps running later checks when an earlier one throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const boom = jest.fn().mockRejectedValue(new Error('db down'));
    const after = jest.fn().mockResolvedValue(0);
    const service = new ReconcilerService([
      check('boom', boom),
      check('after', after),
    ]);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalled();
  });

  it('skips a tick while the previous one is still running, so a slow database cannot pile ticks up', async () => {
    let release!: () => void;
    const slow = jest.fn().mockImplementation(
      () =>
        new Promise<number>((r) => {
          release = () => r(0);
        }),
    );
    const service = new ReconcilerService([check('slow', slow)]);

    const first = service.tick();
    await service.tick(); // must return immediately without invoking the check again

    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('passes one consistent timestamp to every check', async () => {
    const seen: Date[] = [];
    const record = jest.fn().mockImplementation((now: Date) => {
      seen.push(now);
      return Promise.resolve(0);
    });
    const service = new ReconcilerService([
      check('a', record),
      check('b', record),
    ]);

    await service.tick();

    expect(seen[0]).toBe(seen[1]);
  });
});
