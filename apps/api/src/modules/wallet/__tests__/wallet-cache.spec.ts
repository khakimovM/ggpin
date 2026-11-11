import type { RedisService } from '../../../infra/redis/redis.service';
import { WalletCache } from '../wallet-cache';

interface FakeClient {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}

function cacheWith(client: FakeClient): WalletCache {
  return new WalletCache({ client } as unknown as RedisService);
}

const working = (): FakeClient => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
});

describe('WalletCache', () => {
  it('get: miss is null, a stored balance (also negative) is a bigint', async () => {
    const client = working();
    const cache = cacheWith(client);
    await expect(cache.get('u1')).resolves.toBeNull();
    client.get.mockResolvedValueOnce('2034100').mockResolvedValueOnce('-550000');
    await expect(cache.get('u1')).resolves.toBe(2_034_100n);
    await expect(cache.get('u1')).resolves.toBe(-550_000n);
    expect(client.get).toHaveBeenCalledWith('wallet:u1');
  });

  it('get: a corrupt value is a miss, not a balance', async () => {
    const client = working();
    client.get.mockResolvedValue('12abc');
    await expect(cacheWith(client).get('u1')).resolves.toBeNull();
  });

  it('set: writes the decimal string under wallet:{userId} with a 60 s expiry', async () => {
    const client = working();
    await cacheWith(client).set('u1', -5n);
    expect(client.set).toHaveBeenCalledWith('wallet:u1', '-5', 'EX', 60);
  });

  it('invalidate: deletes wallet:{userId}', async () => {
    const client = working();
    await cacheWith(client).invalidate('u1');
    expect(client.del).toHaveBeenCalledWith('wallet:u1');
  });

  it('Redis failing is never an error: get is a miss, set and del resolve', async () => {
    const down = new Error('connect ECONNREFUSED');
    const client: FakeClient = {
      get: jest.fn().mockRejectedValue(down),
      set: jest.fn().mockRejectedValue(down),
      del: jest.fn().mockRejectedValue(down),
    };
    const cache = cacheWith(client);
    await expect(cache.get('u1')).resolves.toBeNull();
    await expect(cache.set('u1', 1n)).resolves.toBeUndefined();
    await expect(cache.invalidate('u1')).resolves.toBeUndefined();
  });

  it('a Redis that never answers gives up (get -> miss) instead of hanging the request', async () => {
    jest.useFakeTimers();
    try {
      const client = working();
      client.get.mockReturnValue(new Promise(() => undefined));
      const pending = cacheWith(client).get('u1');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a user id that could leave the key namespace (miss, nothing sent)', async () => {
    const client = working();
    await expect(cacheWith(client).get('a:b')).resolves.toBeNull();
    expect(client.get).not.toHaveBeenCalled();
  });
});
