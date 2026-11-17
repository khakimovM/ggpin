import { Logger } from '@nestjs/common';
import { ORDER_LOCK_STUCK_AFTER_MS, notifyJobSchema, refIdSubject } from '@repo/shared';
import { episodeRef } from '../guard-ref';
import { OrderLockKeyWalk } from '../order-lock-keys';
import { MAX_TRACKED, OrderLockStuckStep } from '../order-lock-stuck.step';
import type { OrderSweepsRepository } from '../order-sweeps.repository';
import type { ReconcileNotifier } from '../reconcile-notifier';
import { FakeLockRedis } from './order-lock-keys.fake';

// D-64 (3), Q-17, S9d fix F1/F4: a lease whose SAME holder (token) has kept an unchanged open order
// for ORDER_LOCK_STUCK_AFTER_MS, proven by two looks of this process, is the owner's `needsReview`
// alert `<orderId>_lock_<hour>`, whatever the order's job does; the key itself is never touched.

const NOW = 1_790_000_000_000;
const STUCK = ORDER_LOCK_STUCK_AFTER_MS;
const HOUR = (ms: number) => String(Math.floor(ms / 3_600_000));
const ORDER = 'cmabc123lockstuck000000001';
const KEY = `lock:order:${ORDER}`;

function build(options: { unchanged?: string[] } = {}) {
  const redis = new FakeLockRedis();
  redis.values.set(KEY, 'token-a');
  const keys = new OrderLockKeyWalk(redis);
  const repository = { openUnchanged: jest.fn().mockResolvedValue(options.unchanged ?? [ORDER]) };
  const notifier = { alert: jest.fn().mockResolvedValue(true) };
  const step = new OrderLockStuckStep(
    keys,
    repository as unknown as OrderSweepsRepository,
    notifier as unknown as ReconcileNotifier,
  );
  return { step, repository, notifier, redis };
}

describe('episodeRef, scope lock (the stuck lease alert)', () => {
  it('is <orderId>_lock_<hour>, read back as the order, a valid alert id, never the plain id', () => {
    const ref = episodeRef(ORDER, 'lock', NOW);
    expect(ref).toBe(`${ORDER}_lock_${HOUR(NOW)}`);
    expect(refIdSubject(ref ?? '')).toBe(ORDER);
    const job = { kind: 'OWNER_ALERT', alert: 'needsReview', refId: ref };
    expect(notifyJobSchema.safeParse(job).success).toBe(true);
    expect(ref).not.toBe(ORDER);
  });
});

describe('OrderLockStuckStep', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('one look is never an alert; the same holder 30 min later is (F4)', async () => {
    const { step, notifier, repository } = build();
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ watching: 1 });
    expect(repository.openUnchanged).toHaveBeenCalledWith([ORDER], new Date(NOW - STUCK));
    expect((await step.run({ nowMs: NOW + STUCK - 1 })).counts).toEqual({ watching: 1 });
    expect(notifier.alert).not.toHaveBeenCalled();

    const report = await step.run({ nowMs: NOW + STUCK });
    expect(notifier.alert).toHaveBeenCalledTimes(1);
    expect(notifier.alert).toHaveBeenCalledWith(
      'needsReview',
      `${ORDER}_lock_${HOUR(NOW + STUCK)}`,
    );
    expect(report).toEqual({ step: 'lockStuck', counts: { alerted: 1 }, ids: [ORDER] });
  });

  it('a new holder starts the watch again (another replica, a run that began): no alert', async () => {
    const { step, notifier, redis } = build();
    await step.run({ nowMs: NOW });
    redis.values.set(KEY, 'token-b');
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ watching: 1 });
    expect(notifier.alert).not.toHaveBeenCalled();
    expect((await step.run({ nowMs: NOW + 2 * STUCK })).counts).toEqual({ alerted: 1 });
  });

  it('the key went away: released, and the holder is forgotten', async () => {
    const { step, notifier, redis } = build();
    await step.run({ nowMs: NOW });
    redis.scanOnly.add(KEY); // listed by the walk, gone by the GET
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ released: 1 });
    redis.scanOnly.delete(KEY);
    // The same token again later is a new watch, not a lease seen 30 minutes ago.
    expect((await step.run({ nowMs: NOW + STUCK + 1 })).counts).toEqual({ watching: 1 });
    expect(notifier.alert).not.toHaveBeenCalled();
  });

  it('the order moved (or is finished): watched, never counted or alerted', async () => {
    const { step, notifier, repository } = build({ unchanged: [] });
    expect((await step.run({ nowMs: NOW })).counts).toEqual({});
    repository.openUnchanged.mockResolvedValue([ORDER]);
    // It was remembered: unchanged now, and the same holder for 30 minutes.
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ alerted: 1 });
    expect(notifier.alert).toHaveBeenCalledTimes(1);
  });

  it('UNNAMED (no token: an empty value or another type): logged once, its own count, alerted', async () => {
    const { step, redis } = build();
    redis.values.set(KEY, '');
    const error = jest.spyOn(Logger.prototype, 'error');
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ unnamedWatching: 1 });
    redis.values.delete(KEY);
    redis.wrongType.add(KEY);
    expect((await step.run({ nowMs: NOW + 1 })).counts).toEqual({ unnamedWatching: 1 });
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ unnamedAlerted: 1 });
    expect(error.mock.calls.filter((c) => String(c[0]).includes('UNNAMED'))).toHaveLength(1);
  });

  it('a lost alert is counted, never thrown', async () => {
    const { step, notifier } = build();
    notifier.alert.mockResolvedValue(false);
    await step.run({ nowMs: NOW });
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ alertLost: 1 });
  });

  it('a holder no full SCAN cycle returns any more is forgotten', async () => {
    const { step, notifier, redis } = build();
    await step.run({ nowMs: NOW }); // one key: every tick is a full cycle
    redis.values.delete(KEY);
    await step.run({ nowMs: NOW + 1 }); // not listed: pruned at the cycle's end
    redis.values.set(KEY, 'token-a');
    expect((await step.run({ nowMs: NOW + STUCK })).counts).toEqual({ watching: 1 });
    expect(notifier.alert).not.toHaveBeenCalled();
  });

  it(`remembers at most ${String(MAX_TRACKED)} leases: more are untracked, never alerted`, async () => {
    const { step, redis, repository } = build();
    redis.values.clear();
    const ids = Array.from({ length: MAX_TRACKED + 1 }, (_, i) => `cmorder${String(i)}`);
    for (const id of ids) redis.values.set(`lock:order:${id}`, 'token');
    repository.openUnchanged.mockResolvedValue([]);
    let untracked = 0;
    for (let tick = 0; tick * 100 < ids.length; tick += 1) {
      untracked += (await step.run({ nowMs: NOW })).counts['untracked'] ?? 0;
    }
    expect(untracked).toBe(1);
  });
});
