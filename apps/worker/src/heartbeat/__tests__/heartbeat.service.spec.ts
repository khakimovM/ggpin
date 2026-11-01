import { Logger } from '@nestjs/common';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { fakeRedisClient, type FakeRedisClient } from '../../__tests__/fake-infra';
import type { RedisService } from '../../infra/redis/redis.service';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_MS, HeartbeatService } from '../heartbeat.service';

function build(client: FakeRedisClient): HeartbeatService {
  // Only `client.set` / `client.eval` are used; the fake is shaped for exactly that.
  return new HeartbeatService({ client } as unknown as RedisService);
}

describe('HeartbeatService', () => {
  let redis: FakeRedisClient;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = fakeRedisClient();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps the TTL at 3x the interval', () => {
    expect(HEARTBEAT_TTL_MS).toBe(3 * HEARTBEAT_INTERVAL_MS);
  });

  it('writes ISO time + pid with a TTL at boot and on every interval', async () => {
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(redis.set).toHaveBeenCalledTimes(1);

    const [key, value, mode, ttl] = redis.set.mock.calls[0] ?? [];
    expect(key).toBe(WORKER_HEARTBEAT_KEY);
    expect(mode).toBe('PX');
    expect(ttl).toBe(HEARTBEAT_TTL_MS);
    const beat = JSON.parse(value ?? '') as { at: string; pid: number };
    expect(beat.pid).toBe(process.pid);
    expect(new Date(beat.at).toISOString()).toBe(beat.at);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(redis.set).toHaveBeenCalledTimes(3);
    await service.onModuleDestroy();
  });

  it('skips a tick while the previous write is still pending', async () => {
    let release: (v: string) => void = () => undefined;
    redis.set.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(redis.set).toHaveBeenCalledTimes(1);

    release('OK');
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(redis.set).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('survives Redis errors, warns once per outage and keeps beating', async () => {
    redis.set.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(redis.set).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);

    redis.set.mockResolvedValue('OK');
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(log).toHaveBeenCalledWith('heartbeat restored');
    await service.onModuleDestroy();
  });

  it('stops the timer and deletes only its own key on shutdown', async () => {
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    const written = redis.set.mock.calls[0]?.[1];

    await service.onModuleDestroy();
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, WORKER_HEARTBEAT_KEY, written);
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('does not hang shutdown when Redis never answers', async () => {
    redis.eval.mockReturnValue(new Promise<number>(() => undefined));
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    const stopping = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(stopping).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('skips the key cleanup when it never wrote one', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    const service = build(redis);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    await service.onModuleDestroy();
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
