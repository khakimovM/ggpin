import type { RedisService } from '../redis.service';
import { FixedWindowCounter } from '../fixed-window-counter';

function counterWith(results: unknown) {
  const calls: string[] = [];
  const chain = {
    incr: (key: string) => {
      calls.push(`incr ${key}`);
      return chain;
    },
    expire: (key: string, seconds: number, mode: string) => {
      calls.push(`expire ${key} ${String(seconds)} ${mode}`);
      return chain;
    },
    exec: () => Promise.resolve(results),
  };
  const redis = { client: { multi: () => chain } } as unknown as RedisService;
  return { counter: new FixedWindowCounter(redis), calls };
}

describe('FixedWindowCounter', () => {
  it('INCR and EXPIRE NX in one MULTI, returns the count', async () => {
    const { counter, calls } = counterWith([
      [null, 3],
      [null, 0],
    ]);
    await expect(counter.hit('rl:x', 60)).resolves.toBe(3);
    expect(calls).toEqual(['incr rl:x', 'expire rl:x 60 NX']);
  });

  it('surfaces a command error so the caller decides what to do', async () => {
    const { counter } = counterWith([[new Error('boom'), null]]);
    await expect(counter.hit('rl:x', 60)).rejects.toThrow('boom');
  });

  it('rejects when MULTI returns nothing', async () => {
    const { counter } = counterWith(null);
    await expect(counter.hit('rl:x', 60)).rejects.toThrow();
  });
});
