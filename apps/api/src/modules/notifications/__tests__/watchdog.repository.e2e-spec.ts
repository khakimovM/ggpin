import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { RedisService } from '../../../infra/redis/redis.service';
import { QUEUE_WATCH_KEY, WatchdogRepository } from '../watchdog.repository';

// The watchdog's reads and writes against real Redis (DB 15) and BullMQ: Redis TIME, which
// waiting fulfill-order job is the oldest, a job's state and take count, the queue-watch CAS. A private queue name (never the shared `fulfill-order`),
// obliterated at the end; job ids are synthetic.
describe('WatchdogRepository (real Redis + BullMQ)', () => {
  const env = buildE2eEnv();
  const queue = new Queue(`fulfill-order-e2e-${randomUUID()}`, {
    connection: { url: env.REDIS_URL },
  });
  const redis = new RedisService(env);
  const repo = new WatchdogRepository(redis, queue);
  const MIN = 60_000;

  afterAll(async () => {
    await redis.client.del(QUEUE_WATCH_KEY);
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.client.quit();
  });

  it('reads Redis time (TIME) in epoch ms', async () => {
    const before = Date.now();
    const ms = await repo.redisNowMs();
    // Same machine in the test: the two clocks agree to well within a few seconds.
    expect(Math.abs(ms - before)).toBeLessThan(5_000);
    expect(Number.isSafeInteger(ms)).toBe(true);
  });

  it('an empty queue has no oldest job', async () => {
    await expect(repo.oldestWaitingFulfillJob()).resolves.toBeNull();
  });

  it('the oldest waiting job: the first added to wait, an older prioritized one, never delayed', async () => {
    const now = Date.now();
    await queue.add('fulfill', { orderId: 'old' }, { jobId: 'cmold', timestamp: now - 6 * MIN });
    await queue.add('fulfill', { orderId: 'new' }, { jobId: 'cmnew', timestamp: now - MIN });
    // A retry waiting out its backoff (due in an hour: BullMQ counts the delay from `timestamp`)
    // is not waiting for the worker and is never read.
    await queue.add(
      'fulfill',
      { orderId: 'later' },
      { jobId: 'cmdelayed', timestamp: now, delay: 60 * MIN },
    );
    await expect(repo.oldestWaitingFulfillJob()).resolves.toEqual({
      id: 'cmold',
      addedAt: now - 6 * MIN,
      taken: 0,
    });

    await queue.add(
      'fulfill',
      { orderId: 'prio' },
      { jobId: 'cmprio', timestamp: now - 9 * MIN, priority: 5 },
    );
    await expect(repo.oldestWaitingFulfillJob()).resolves.toEqual({
      id: 'cmprio',
      addedAt: now - 9 * MIN,
      taken: 0,
    });
    await expect(repo.fulfillJob('cmold')).resolves.toEqual({ state: 'waiting', taken: 0 });
    await expect(repo.fulfillJob('cmprio')).resolves.toEqual({ state: 'prioritized', taken: 0 });
    await expect(repo.fulfillJob('cmdelayed')).resolves.toEqual({ state: 'delayed', taken: 0 });
    await expect(repo.fulfillJob('cmmissing')).resolves.toBeNull();
  });

  it('a job taken by a worker counts the take; a retry back in wait keeps it', async () => {
    await queue.obliterate({ force: true });
    await queue.add('fulfill', { orderId: 'retry' }, { jobId: 'cmretry', attempts: 2 });
    const worker = new Worker(queue.name, null, {
      connection: { url: env.REDIS_URL },
      autorun: false,
    });
    try {
      const token = randomUUID();
      const job = await worker.getNextJob(token);
      expect(job?.id).toBe('cmretry');
      await expect(repo.fulfillJob('cmretry')).resolves.toEqual({ state: 'active', taken: 1 });
      await job?.moveToFailed(new Error('synthetic'), token);
      // No backoff: straight back to wait, with the take counted.
      await expect(repo.fulfillJob('cmretry')).resolves.toEqual({ state: 'waiting', taken: 1 });
      await expect(repo.oldestWaitingFulfillJob()).resolves.toMatchObject({
        id: 'cmretry',
        taken: 1,
      });
    } finally {
      await worker.close();
    }
  });

  it('the queue watch is a compare-and-set: first writer wins, a stale write fails', async () => {
    await redis.client.del(QUEUE_WATCH_KEY);
    await expect(repo.replaceQueueWatch(null, 'a')).resolves.toBe(true);
    await expect(repo.replaceQueueWatch(null, 'b')).resolves.toBe(false);
    await expect(repo.replaceQueueWatch('x', 'b')).resolves.toBe(false);
    await expect(repo.queueWatch()).resolves.toBe('a');
    await expect(repo.replaceQueueWatch('a', 'b')).resolves.toBe(true);
    expect(await redis.client.pttl(QUEUE_WATCH_KEY)).toBeGreaterThan(29 * 24 * 60 * MIN);
    await expect(repo.replaceQueueWatch('b', null)).resolves.toBe(true);
    await expect(repo.queueWatch()).resolves.toBeNull();
    // An empty stored value (an edited key) is a value, not "absent": it can still be replaced.
    await redis.client.set(QUEUE_WATCH_KEY, '');
    await expect(repo.replaceQueueWatch(null, 'c')).resolves.toBe(false);
    await expect(repo.replaceQueueWatch('', 'c')).resolves.toBe(true);
    await expect(repo.queueWatch()).resolves.toBe('c');
  });
});
