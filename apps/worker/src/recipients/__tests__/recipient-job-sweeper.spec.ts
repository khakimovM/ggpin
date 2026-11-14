import type { Queue } from 'bullmq';
import type { RedisService } from '../../infra/redis/redis.service';
import { DEFAULT_RECIPIENT_CHECK_TIMING } from '../recipient-check.config';
import { RecipientJobSweeper, SWEEP_BATCH, SWEPT_STATES } from '../recipient-job-sweeper';

// The retention sweep of validate-recipient (S3a review finding 2, audit L-2) without Redis; the
// e2e suite proves a finished job and its events really disappear while no other job finishes.

type Clean = (grace: number, limit: number, state: string) => Promise<string[]>;
const EVENTS_KEY = 'bull:validate-recipient:events';
/** Redis TIME of the fake server: seconds, microseconds (as strings, like the real reply). */
const SERVER_TIME = ['1800000000', '123456'];
const SERVER_MS = 1_800_000_000_123;

function build(clean: jest.Mock<ReturnType<Clean>, Parameters<Clean>>) {
  const queue = { clean, toKey: (type: string) => `bull:validate-recipient:${type}` };
  const time = jest.fn(() => Promise.resolve(SERVER_TIME));
  const xtrim = jest.fn((..._args: unknown[]) => Promise.resolve(0));
  const redis = { client: { time, xtrim } };
  const sweeper = new RecipientJobSweeper(
    queue as unknown as Queue,
    DEFAULT_RECIPIENT_CHECK_TIMING,
    redis as unknown as RedisService,
  );
  const warn = jest.fn();
  const log = jest.fn();
  sweeper['logger'].warn = warn;
  sweeper['logger'].log = log;
  return { sweeper, warn, log, time, xtrim };
}

const none = () => jest.fn<ReturnType<Clean>, Parameters<Clean>>(() => Promise.resolve([]));

afterEach(() => jest.useRealTimers());

describe('RecipientJobSweeper', () => {
  it('cleans completed, failed, never-taken and prioritized jobs older than the 60 s retention', async () => {
    const clean = none();
    const { sweeper } = build(clean);
    await sweeper.sweep();
    expect(SWEPT_STATES).toEqual(['completed', 'failed', 'wait', 'prioritized']);
    expect(clean.mock.calls).toEqual([
      [60_000, SWEEP_BATCH, 'completed'],
      [60_000, SWEEP_BATCH, 'failed'],
      [60_000, SWEEP_BATCH, 'wait'],
      [60_000, SWEEP_BATCH, 'prioritized'],
    ]);
  });

  it('trims the events stream exactly (MINID, no ~) at server time - retention', async () => {
    const { sweeper, xtrim } = build(none());
    await sweeper.sweep();
    expect(xtrim).toHaveBeenCalledTimes(1);
    expect(xtrim).toHaveBeenCalledWith(EVENTS_KEY, 'MINID', String(SERVER_MS - 60_000));
  });

  it('a TIME reply that is not a number is a failed sweep, never a wild trim', async () => {
    const { sweeper, time, xtrim, warn } = build(none());
    time.mockResolvedValueOnce(['nope', '1']);
    await sweeper.sweep();
    expect(xtrim).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('validate-recipient sweep failed: TypeError');
  });

  it('runs at boot and every 30 s (gone within two retention windows), stops on shutdown', async () => {
    jest.useFakeTimers();
    const clean = none();
    const { sweeper, xtrim } = build(clean);
    expect(DEFAULT_RECIPIENT_CHECK_TIMING.sweepEveryMs).toBe(30_000);
    sweeper.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(clean).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(clean).toHaveBeenCalledTimes(8);
    expect(xtrim).toHaveBeenCalledTimes(2);
    await sweeper.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(clean).toHaveBeenCalledTimes(8);
  });

  it('a full batch is followed by another one (bounded)', async () => {
    const full = Array.from({ length: SWEEP_BATCH }, (_, i) => `id-${String(i)}`);
    const clean = none().mockResolvedValueOnce(full).mockResolvedValueOnce(full);
    const { sweeper } = build(clean);
    await sweeper.sweep();
    expect(clean.mock.calls.map((call) => call[2])).toEqual([
      'completed',
      'completed',
      'completed',
      'failed',
      'wait',
      'prioritized',
    ]);
  });

  it('a Redis error is one warning with the class name only, never a crash; recovery is logged', async () => {
    const clean = none()
      .mockRejectedValueOnce(new TypeError('redis://user:pw@host vr-abc'))
      .mockRejectedValueOnce(new TypeError('again'));
    const { sweeper, warn, log } = build(clean);
    await expect(sweeper.sweep()).resolves.toBeUndefined();
    await expect(sweeper.sweep()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('validate-recipient sweep failed: TypeError');
    await sweeper.sweep();
    expect(log).toHaveBeenCalledWith('validate-recipient sweep restored');
  });

  it('an XTRIM error follows the same warning pattern', async () => {
    const { sweeper, xtrim, warn } = build(none());
    xtrim.mockRejectedValueOnce(new RangeError('ERR vr-0123 in the stream'));
    await expect(sweeper.sweep()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('validate-recipient sweep failed: RangeError');
  });

  it('a tick while a sweep runs joins it instead of starting another', async () => {
    let release: () => void = () => undefined;
    const clean = none().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const { sweeper } = build(clean);
    const first = sweeper.sweep();
    const second = sweeper.sweep();
    expect(second).toBe(first);
    release();
    await first;
    expect(clean).toHaveBeenCalledTimes(4);
  });
});
