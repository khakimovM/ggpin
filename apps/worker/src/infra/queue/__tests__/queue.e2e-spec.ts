import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken, Processor, WorkerHost } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { HeartbeatService } from '../../../heartbeat/heartbeat.service';
import { WorkerModule } from '../../../worker.module';
import { workerBullOptions } from '../queue.module';

// Throwaway queue per run: only this name is ever obliterated, never a real queue name, so the
// suite is safe on a shared Redis (it also runs in logical DB 15, see e2e-env.ts).
const TEST_QUEUE = `e2e-test-${randomUUID()}`;

function createTestProcessor(queueName: string) {
  // Test-only consumer, registered through the same @nestjs/bullmq wiring real processors use.
  @Processor(queueName)
  class TestProcessor extends WorkerHost {
    process(job: Job<{ n: number }>): Promise<{ doubled: number }> {
      return Promise.resolve({ doubled: job.data.n * 2 });
    }
  }
  return TestProcessor;
}

describe('BullMQ wiring (real Redis)', () => {
  const env = buildE2eEnv();
  const { connection } = workerBullOptions(env);
  let moduleRef: TestingModule;
  let redis: Redis;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    redis = new Redis(env.REDIS_URL);
    queueEvents = new QueueEvents(TEST_QUEUE, { connection });
    await queueEvents.waitUntilReady();
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule.register(env), BullModule.registerQueue({ name: TEST_QUEUE })],
      providers: [createTestProcessor(TEST_QUEUE)],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
    await queueEvents.close();
    const cleanup = new Queue(TEST_QUEUE, { connection });
    await cleanup.obliterate({ force: true });
    await cleanup.close();
    await redis.quit();
  });

  it('a job added to the test queue is consumed by the test processor', async () => {
    const queue = moduleRef.get<Queue>(getQueueToken(TEST_QUEUE), { strict: false });
    const job = await queue.add('double', { n: 21 }, { jobId: `consume-${randomUUID()}` });
    await expect(job.waitUntilFinished(queueEvents, 10_000)).resolves.toEqual({ doubled: 42 });
  });

  it('adding the same jobId twice yields one job (jobId = orderId idempotency)', async () => {
    // A separate, consumer-less queue so the first job is still present when the second add
    // arrives (a consumed + removed job would not prove deduplication).
    const name = `${TEST_QUEUE}-dedupe`;
    const queue = new Queue(name, { connection });
    try {
      const first = await queue.add('fulfill', { orderId: 'order-1' }, { jobId: 'order-1' });
      const second = await queue.add('fulfill', { orderId: 'order-1' }, { jobId: 'order-1' });
      expect(second.id).toBe(first.id);
      expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('the running worker keeps a heartbeat key with a TTL', async () => {
    await moduleRef.get(HeartbeatService).beat();
    const raw = await redis.get(WORKER_HEARTBEAT_KEY);
    expect(raw).not.toBeNull();
    const beat = JSON.parse(raw ?? '') as { at: string; pid: number };
    expect(beat.pid).toBe(process.pid);
    expect(new Date(beat.at).toISOString()).toBe(beat.at);
    const ttl = await redis.pttl(WORKER_HEARTBEAT_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });
});

describe('heartbeat on shutdown (real Redis)', () => {
  it('removes its key when the worker closes', async () => {
    const env = buildE2eEnv();
    const redis = new Redis(env.REDIS_URL);
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule.register(env)],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    let closed = false;
    try {
      // Boot fires the first beat without awaiting it; join that in-flight write.
      await moduleRef.get(HeartbeatService).beat();
      expect(await redis.exists(WORKER_HEARTBEAT_KEY)).toBe(1);
      await moduleRef.close();
      closed = true;
      expect(await redis.exists(WORKER_HEARTBEAT_KEY)).toBe(0);
    } finally {
      if (!closed) await moduleRef.close();
      await redis.quit();
    }
  });
});
