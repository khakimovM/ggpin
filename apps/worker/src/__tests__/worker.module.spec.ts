import { getQueueOptionsToken, getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  PRICE_SYNC_EVERY_MS,
  QUEUE_JOB_DEFAULTS,
  QUEUE_NAMES,
  QUEUES,
  WORKER_HEARTBEAT_KEY,
} from '@repo/shared';
import type { RegisterQueueOptions } from '@nestjs/bullmq';
import { buildTestEnv } from '../config/__tests__/test-env';
import { HeartbeatService } from '../heartbeat/heartbeat.service';
import { PriceSyncScheduler } from '../pricing-sync/price-sync.scheduler';
import { TopupExpireScheduler } from '../bank-feed/topup-expire.scheduler';
import { PaymentReconcileScheduler } from '../reconcile/payment-reconcile.scheduler';
import { WorkerModule } from '../worker.module';
import { fakeRedisClient, withFakeInfra, type FakeQueue, type FakeRedisClient } from './fake-infra';

// The real module graph with only the network edges (queue instances, Redis client) faked:
// no Redis or Postgres is needed.
describe('WorkerModule', () => {
  let moduleRef: TestingModule;
  let redis: FakeRedisClient;
  let queues: Map<string, FakeQueue>;

  beforeEach(async () => {
    redis = fakeRedisClient();
    queues = new Map();
    moduleRef = await withFakeInfra(
      Test.createTestingModule({
        imports: [WorkerModule.register(buildTestEnv({ REDIS_URL: 'redis://example.test:6380' }))],
      }),
      redis,
      queues,
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

  it('schedules the fx and cost price-sync jobs on boot under fixed scheduler ids', async () => {
    await moduleRef.init();
    await moduleRef.get(PriceSyncScheduler).whenScheduled();
    const queue = queues.get(QUEUES.PRICE_SYNC);
    expect(queue?.upsertJobScheduler.mock.calls).toEqual([
      ['price-sync:fx', { every: PRICE_SYNC_EVERY_MS }, { name: 'fx', data: {} }],
      ['price-sync:cost', { every: PRICE_SYNC_EVERY_MS }, { name: 'cost', data: {} }],
    ]);
    // New schedulers run at once (delay 0), so no extra immediate job is added.
    expect(queue?.add).not.toHaveBeenCalled();
  });

  it('schedules the every-minute topup-expire sweep, the 03:00 Tashkent reconciliation and the 03:30 text purge', async () => {
    await moduleRef.init();
    await moduleRef.get(TopupExpireScheduler).whenScheduled();
    await moduleRef.get(PaymentReconcileScheduler).whenScheduled();
    expect(queues.get(QUEUES.TOPUP_EXPIRE)?.upsertJobScheduler.mock.calls).toEqual([
      ['topup-expire:sweep', { every: 60_000 }, { name: 'sweep', data: {} }],
    ]);
    expect(queues.get(QUEUES.PAYMENT_RECONCILE)?.upsertJobScheduler.mock.calls).toEqual([
      [
        'payment-reconcile:daily',
        { pattern: '0 3 * * *', tz: 'Asia/Tashkent' },
        { name: 'daily', data: {} },
      ],
      [
        'payment-reconcile:bank-text-purge',
        { pattern: '30 3 * * *', tz: 'Asia/Tashkent' },
        { name: 'bank-text-purge', data: {} },
      ],
    ]);
  });
});
