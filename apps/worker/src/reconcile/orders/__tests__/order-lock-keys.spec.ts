import { MAX_PENDING, OrderLockKeyWalk } from '../order-lock-keys';
import { FakeLockRedis } from './order-lock-keys.fake';

// The read-only walk over `lock:order:*` (phase 5 S9d; fix F5/F7): SCAN resumes from tick to tick,
// ids past the tick's limit wait for the next tick (bounded), a batch that ends a full cycle says
// so, and a lease's holder is read with GET only.

const key = (id: string) => `lock:order:${id}`;

function redisWith(ids: readonly string[]): FakeLockRedis {
  const redis = new FakeLockRedis();
  for (const id of ids) redis.values.set(key(id), `token-${id}`);
  return redis;
}

describe('OrderLockKeyWalk', () => {
  it('collects order ids from the lease keys, skips malformed ones, asks for the pattern only', async () => {
    const redis = redisWith(['cmorder1', 'cmorder2']);
    redis.values.set('lock:order:bad-id', 'x');
    const scan = jest.spyOn(redis, 'scan');
    const walk = new OrderLockKeyWalk(redis);
    expect(await walk.next(100)).toEqual({
      orderIds: ['cmorder1', 'cmorder2'],
      malformed: 1,
      overflow: 0,
      wrapped: true,
    });
    expect(scan).toHaveBeenCalledWith('0', 'MATCH', 'lock:order:*', 'COUNT', 500);
  });

  it('F7: ids of a page past the limit come first next tick, none is skipped', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `cmorder${String(i)}`);
    const walk = new OrderLockKeyWalk(redisWith(ids));
    const seen: string[] = [];
    const first = await walk.next(3);
    expect(first.orderIds).toHaveLength(3);
    expect(first.wrapped).toBe(false); // four of this cycle still wait
    seen.push(...first.orderIds);
    const second = await walk.next(3);
    expect(second.wrapped).toBe(false);
    seen.push(...second.orderIds);
    const third = await walk.next(3);
    seen.push(...third.orderIds);
    expect(third).toEqual(expect.objectContaining({ wrapped: true }));
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('a finished cycle is reported before the next one starts (no batch mixes two)', async () => {
    const redis = redisWith(['cmorder1', 'cmorder2', 'cmorder3']);
    const walk = new OrderLockKeyWalk(redis);
    const scan = jest.spyOn(redis, 'scan');
    expect((await walk.next(2)).wrapped).toBe(false);
    expect(await walk.next(2)).toEqual(
      expect.objectContaining({ orderIds: ['cmorder3'], wrapped: true }),
    );
    expect(scan).toHaveBeenCalledTimes(1);
    // The next tick starts a new cycle from the cursor 0.
    expect((await walk.next(10)).orderIds).toHaveLength(3);
    expect(scan.mock.calls[1]?.[0]).toBe('0');
  });

  it(`keeps at most ${String(MAX_PENDING)} ids for later; the rest are counted, seen next cycle`, async () => {
    const ids = Array.from({ length: 2_000 }, (_, i) => `cmorder${String(i).padStart(4, '0')}`);
    // COUNT is only a hint: one SCAN answer may carry far more keys than asked.
    const scan = jest.fn().mockResolvedValue(['0', ids.map(key)]);
    const walk = new OrderLockKeyWalk({ scan, get: jest.fn() });
    const first = await walk.next(100);
    expect(first.orderIds).toHaveLength(100);
    expect(first.overflow).toBe(ids.length - 100 - MAX_PENDING);
    let handed = first.orderIds.length;
    let batch = first;
    while (!batch.wrapped) {
      batch = await walk.next(100);
      handed += batch.orderIds.length;
    }
    expect(handed).toBe(100 + MAX_PENDING);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('holder: the token (GET), gone, or UNNAMED (empty value, another type)', async () => {
    const redis = redisWith(['cmorder1']);
    redis.values.set(key('cmempty'), '');
    redis.wrongType.add(key('cmhash'));
    const walk = new OrderLockKeyWalk(redis);
    expect(await walk.holder('cmorder1')).toEqual({ kind: 'token', token: 'token-cmorder1' });
    expect(await walk.holder('cmnone')).toEqual({ kind: 'gone' });
    expect(await walk.holder('cmempty')).toEqual({ kind: 'unnamed' });
    expect(await walk.holder('cmhash')).toEqual({ kind: 'unnamed' });
  });

  it('holder: any other Redis error is thrown (the step counts it as failed)', async () => {
    const walk = new OrderLockKeyWalk({
      scan: jest.fn(),
      get: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
    });
    await expect(walk.holder('cmorder1')).rejects.toThrow('Connection is closed.');
  });
});
