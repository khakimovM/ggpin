import { FRAGMENT_HEALTH_KEY } from '@repo/shared';
import type { RedisService } from '../../../infra/redis/redis.service';
import { FragmentHealth } from '../fragment-health';
import type { FragmentSessionRepository } from '../fragment-session.repository';

// The Fragment health (phase 5 S7): the worker decides by the session rows only (review m2); the
// keep-alive's Redis verdict is the API's view.

function build(redisValue: string | null, state: 'ACTIVE' | 'DEAD' | 'NONE') {
  const client = {
    get: jest.fn(() => Promise.resolve(redisValue)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
  };
  const sessions = { state: jest.fn(() => Promise.resolve(state)) };
  const health = new FragmentHealth(
    { client } as unknown as RedisService,
    sessions as unknown as FragmentSessionRepository,
  );
  return { health, client, sessions };
}

describe('FragmentHealth', () => {
  it.each([
    // A session imported after a death: the dead one's Redis `down` does not hide it (m2).
    ['down', 'ACTIVE', 'ok', 'OK', 'OK'],
    ['ok', 'ACTIVE', 'ok', 'OK', 'OK'],
    [null, 'ACTIVE', 'ok', 'OK', 'OK'],
    ['ok', 'DEAD', 'down', 'DOWN', 'DOWN'],
    [null, 'DEAD', 'down', 'DOWN', 'DOWN'],
    [null, 'NONE', 'disabled', 'DOWN', 'OK'],
    ['down', 'NONE', 'disabled', 'DOWN', 'OK'],
    ['garbage', 'NONE', 'disabled', 'DOWN', 'OK'],
  ] as const)(
    'Redis %s + rows %s -> %s; live adapter %s; simulator %s',
    async (redisValue, state, read, liveHealth, simHealth) => {
      const { health } = build(redisValue, state);
      await expect(health.read()).resolves.toBe(read);
      await expect(health.liveAdapterHealth()).resolves.toBe(liveHealth);
      await expect(health.simulatedAdapterHealth()).resolves.toBe(simHealth);
    },
  );

  it('publishes with a TTL, and removes the value for null', async () => {
    const { health, client } = build(null, 'NONE');
    await health.publish('down', 3_600_000);
    expect(client.set).toHaveBeenCalledWith(FRAGMENT_HEALTH_KEY, 'down', 'PX', 3_600_000);
    await health.publish(null, 1);
    expect(client.del).toHaveBeenCalledWith(FRAGMENT_HEALTH_KEY);
  });

  it('a database that cannot be read throws (the router counts that as not healthy)', async () => {
    const { health, sessions } = build(null, 'ACTIVE');
    sessions.state.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(health.simulatedAdapterHealth()).rejects.toThrow('ECONNREFUSED');
    await expect(health.liveAdapterHealth()).rejects.toThrow('ECONNREFUSED');
  });

  it('the worker never reads Redis to decide; published() is the API view', async () => {
    const { health, client } = build('down', 'ACTIVE');
    await expect(health.read()).resolves.toBe('ok');
    expect(client.get).not.toHaveBeenCalled();
    await expect(health.published()).resolves.toBe('down');
  });
});
