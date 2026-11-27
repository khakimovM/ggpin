import { Logger } from '@nestjs/common';
import {
  BANKFEED_PROCESS_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_KEY,
  workerRoleHeartbeatKeys,
  type WorkerRole,
} from '@repo/shared';
import { fakeRedisClient, type FakeRedisClient } from '../../__tests__/fake-infra';
import type { RedisService } from '../../infra/redis/redis.service';
import { HEARTBEAT_TTL_MS, HeartbeatService } from '../heartbeat.service';

// D-76: fulfillment beats on `worker:heartbeat` only, bankfeed on `bankfeed:process-heartbeat`
// only (so a live bankfeed never hides a dead fulfillment worker), all on both.

function build(client: FakeRedisClient, role: WorkerRole): HeartbeatService {
  // Only `client.set` / `client.eval` are used; the fake is shaped for exactly that.
  return new HeartbeatService({ client } as unknown as RedisService, workerRoleHeartbeatKeys(role));
}

const EXPECTED: Record<WorkerRole, readonly string[]> = {
  fulfillment: [WORKER_HEARTBEAT_KEY],
  bankfeed: [BANKFEED_PROCESS_HEARTBEAT_KEY],
  all: [WORKER_HEARTBEAT_KEY, BANKFEED_PROCESS_HEARTBEAT_KEY],
};

describe.each<WorkerRole>(['fulfillment', 'bankfeed', 'all'])(
  'heartbeat, WORKER_ROLE=%s',
  (role) => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('writes exactly the role keys with the TTL', async () => {
      const redis = fakeRedisClient();
      const service = build(redis, role);
      await service.beat();
      expect(redis.set.mock.calls.map(([key]) => key)).toEqual(EXPECTED[role]);
      for (const [, , mode, ttl] of redis.set.mock.calls)
        expect([mode, ttl]).toEqual(['PX', HEARTBEAT_TTL_MS]);
      const values = new Set(redis.set.mock.calls.map(([, value]) => value));
      expect(values.size).toBe(1);
      await service.onModuleDestroy();
    });

    it('deletes only its own keys (compare-and-delete, one script) on shutdown', async () => {
      const redis = fakeRedisClient();
      const service = build(redis, role);
      await service.beat();
      const written = redis.set.mock.calls[0]?.[1];
      await service.onModuleDestroy();
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval.mock.calls[0]?.slice(1)).toEqual([
        EXPECTED[role].length,
        ...EXPECTED[role],
        written,
      ]);
    });
  },
);

describe('bankfeed heartbeat', () => {
  it('never touches worker:heartbeat', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const redis = fakeRedisClient();
    const service = build(redis, 'bankfeed');
    await service.beat();
    await service.onModuleDestroy();
    const touched = [...redis.set.mock.calls.map(([key]) => key), ...redis.eval.mock.calls.flat()];
    expect(touched).not.toContain(WORKER_HEARTBEAT_KEY);
    jest.restoreAllMocks();
  });
});
