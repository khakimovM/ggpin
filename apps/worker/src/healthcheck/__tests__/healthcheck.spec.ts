import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { loadHealthcheckRedisUrl } from '../../config/healthcheck-env';
import { workerIsHealthy } from '../healthcheck';

describe('workerIsHealthy', () => {
  it('is healthy while the worker heartbeat key exists', async () => {
    const get = jest.fn().mockResolvedValue('{"at":"2026-11-10T00:00:00.000Z","pid":1}');
    await expect(workerIsHealthy({ get })).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY);
  });

  it('is unhealthy once the key has expired', async () => {
    await expect(workerIsHealthy({ get: jest.fn().mockResolvedValue(null) })).resolves.toBe(false);
  });

  it('propagates a Redis failure so the probe reports unreachable', async () => {
    await expect(
      workerIsHealthy({ get: jest.fn().mockRejectedValue(new Error('down')) }),
    ).rejects.toThrow('down');
  });
});

describe('loadHealthcheckRedisUrl', () => {
  it('accepts redis and rediss URLs and rejects anything else without echoing it', () => {
    expect(loadHealthcheckRedisUrl({ REDIS_URL: 'redis://redis:6379/12' })).toBe(
      'redis://redis:6379/12',
    );
    expect(loadHealthcheckRedisUrl({ REDIS_URL: 'rediss://h:6380' })).toBe('rediss://h:6380');
    expect(loadHealthcheckRedisUrl({ REDIS_URL: 'http://x' })).toBeNull();
    expect(loadHealthcheckRedisUrl({})).toBeNull();
  });
});
