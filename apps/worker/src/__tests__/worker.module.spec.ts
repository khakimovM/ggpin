import { getQueueOptionsToken, getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES, WORKER_HEARTBEAT_KEY } from '@repo/shared';
import type { RegisterQueueOptions } from '@nestjs/bullmq';
import { buildTestEnv } from '../config/__tests__/test-env';
import { HeartbeatService } from '../heartbeat/heartbeat.service';
import { WorkerModule } from '../worker.module';
import { fakeRedisClient, withFakeInfra, type FakeRedisClient } from './fake-infra';

// The real module graph with only the network edges (queue instances, Redis client) faked:
// no Redis or Postgres is needed.
describe('WorkerModule', () => {
  let moduleRef: TestingModule;
  let redis: FakeRedisClient;

  beforeEach(async () => {
    redis = fakeRedisClient();
    moduleRef = await withFakeInfra(
      Test.createTestingModule({
        imports: [WorkerModule.register(buildTestEnv({ REDIS_URL: 'redis://example.test:6380' }))],
      }),
      redis,
    ).compile();
    moduleRef.useLogger(false);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it.each(QUEUE_NAMES)('registers queue %s with its retry/retention defaults', (name) => {
    expect(moduleRef.get(getQueueToken(name), { strict: false })).toBeDefined();
    const options = moduleRef.get<RegisterQueueOptions>(getQueueOptionsToken(name), {
      strict: false,
    });
    expect(options.defaultJobOptions).toEqual(QUEUE_JOB_DEFAULTS[name]);
  });

  it('gives BullMQ a blocking-safe connection built from REDIS_URL', () => {
    const options = moduleRef.get<RegisterQueueOptions>(getQueueOptionsToken(QUEUE_NAMES[0]), {
      strict: false,
    });
    expect(options.connection).toEqual({
      url: 'redis://example.test:6380',
      maxRetriesPerRequest: null,
    });
  });

  it('starts the heartbeat on boot and stops it on close', async () => {
    expect(moduleRef.get(HeartbeatService)).toBeInstanceOf(HeartbeatService);
    await moduleRef.init();
    await moduleRef.get(HeartbeatService).beat();
    expect(redis.set).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY, expect.any(String), 'PX', 30_000);

    await moduleRef.close();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});
