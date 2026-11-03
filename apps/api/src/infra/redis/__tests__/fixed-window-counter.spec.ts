import type { RedisService } from '../redis.service';
import { FixedWindowCounter } from '../fixed-window-counter';

function counterWith(outcome: Promise<unknown>) {
  const evalCalls: unknown[][] = [];
  const redis = {
    client: {
      eval: (...args: unknown[]) => {
        evalCalls.push(args);
        return outcome;
      },
    },
  } as unknown as RedisService;
  return { counter: new FixedWindowCounter(redis), evalCalls };
}

describe('FixedWindowCounter', () => {
  it('runs one script (INCR + TTL + EXPIRE when there is no TTL) and returns count and ttl', async () => {
    const { counter, evalCalls } = counterWith(Promise.resolve([3, 41]));
    await expect(counter.hit('rl:x', 60)).resolves.toEqual({ count: 3, ttlSec: 41 });
    expect(evalCalls).toHaveLength(1);
    const [script, keys, key, window] = evalCalls[0] ?? [];
    expect(String(script)).toContain("redis.call('INCR'");
    expect(String(script)).toContain("redis.call('TTL'");
    expect(String(script)).toContain("redis.call('EXPIRE'");
    expect([keys, key, window]).toEqual([1, 'rl:x', 60]);
  });

  it('reports at least one second to wait', async () => {
    const { counter } = counterWith(Promise.resolve([11, 0]));
    await expect(counter.hit('rl:x', 60)).resolves.toEqual({ count: 11, ttlSec: 1 });
  });

  it('surfaces a command error so the caller decides what to do', async () => {
    const { counter } = counterWith(Promise.reject(new Error('boom')));
    await expect(counter.hit('rl:x', 60)).rejects.toThrow('boom');
  });

  it('rejects on a result of the wrong shape', async () => {
    for (const bad of [null, 'OK', [1], ['1', 2]]) {
      const { counter } = counterWith(Promise.resolve(bad));
      await expect(counter.hit('rl:x', 60)).rejects.toThrow();
    }
  });
});
