import type { RedisService } from '../../../infra/redis/redis.service';
import { WalletCache } from '../wallet-cache';

// CR m6: the admin user list reads every balance in ONE MGET and writes the misses back in ONE
// pipeline; both stay best effort (a Redis failure is "no cache", never an error).
function setup() {
  const pipelineSet = jest.fn();
  const exec = jest.fn().mockResolvedValue([]);
  const pipeline = { set: pipelineSet, exec };
  pipelineSet.mockReturnValue(pipeline);
  const client = {
    mget: jest.fn().mockResolvedValue(['2034100', null, '12abc', '-5']),
    pipeline: jest.fn().mockReturnValue(pipeline),
  };
  return {
    client,
    pipelineSet,
    exec,
    cache: new WalletCache({ client } as unknown as RedisService),
  };
}

describe('WalletCache getMany / setMany', () => {
  it('getMany: one MGET; misses and corrupt values are left out', async () => {
    const { client, cache } = setup();
    const found = await cache.getMany(['u1', 'u2', 'u3', 'u4']);
    expect(client.mget).toHaveBeenCalledTimes(1);
    expect(client.mget).toHaveBeenCalledWith('wallet:u1', 'wallet:u2', 'wallet:u3', 'wallet:u4');
    expect([...found]).toEqual([
      ['u1', 2_034_100n],
      ['u4', -5n],
    ]);
  });

  it('getMany: no ids, no round trip; Redis down is an empty map', async () => {
    const { client, cache } = setup();
    await expect(cache.getMany([])).resolves.toEqual(new Map());
    expect(client.mget).not.toHaveBeenCalled();
    client.mget.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(cache.getMany(['u1'])).resolves.toEqual(new Map());
  });

  it('setMany: one pipeline, each key with the 60 s expiry; a failure resolves', async () => {
    const { client, pipelineSet, exec, cache } = setup();
    await cache.setMany(
      new Map([
        ['u1', 7n],
        ['u2', -3n],
      ]),
    );
    expect(client.pipeline).toHaveBeenCalledTimes(1);
    expect(pipelineSet.mock.calls).toEqual([
      ['wallet:u1', '7', 'EX', 60],
      ['wallet:u2', '-3', 'EX', 60],
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockRejectedValueOnce(new Error('down'));
    await expect(cache.setMany(new Map([['u1', 1n]]))).resolves.toBeUndefined();
    await cache.setMany(new Map());
    expect(client.pipeline).toHaveBeenCalledTimes(2);
  });
});
