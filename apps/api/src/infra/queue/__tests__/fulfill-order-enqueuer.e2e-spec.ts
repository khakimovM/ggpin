import { randomUUID } from 'node:crypto';
import { QUEUE_JOB_DEFAULTS, QUEUES, type FulfillOrderJobData } from '@repo/shared';
import { Queue, Worker } from 'bullmq';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { FulfillOrderEnqueuer, isLockedRemovalError } from '../fulfill-order-enqueuer';

// Real Redis (logical DB 15, see e2e-env.ts). Throwaway queue names: only those are ever
// obliterated, never the real fulfill-order queue.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

describe('FulfillOrderEnqueuer (real Redis)', () => {
  const env = buildE2eEnv();
  // Same retention as production, but a single attempt so a failing processor ends in `failed`
  // immediately instead of backing off for 5 s.
  const defaultJobOptions = { ...QUEUE_JOB_DEFAULTS[QUEUES.FULFILL_ORDER], attempts: 1 };
  const opened: Array<{ close(): Promise<void> }> = [];
  const queuesToClean: Queue[] = [];

  function makeQueue(): { queue: Queue<FulfillOrderJobData>; enqueuer: FulfillOrderEnqueuer } {
    const queue = new Queue<FulfillOrderJobData>(`e2e-fulfill-${randomUUID()}`, {
      connection: { url: env.REDIS_URL },
      defaultJobOptions,
    });
    queuesToClean.push(queue);
    return { queue, enqueuer: new FulfillOrderEnqueuer(queue) };
  }

  function startWorker(queue: Queue, failOrderIds: ReadonlySet<string> = new Set()) {
    const runs: string[] = [];
    const worker = new Worker<FulfillOrderJobData>(
      queue.name,
      (job) => {
        runs.push(job.data.orderId);
        if (failOrderIds.has(job.data.orderId)) return Promise.reject(new Error('boom'));
        return Promise.resolve();
      },
      { connection: { url: env.REDIS_URL, maxRetriesPerRequest: null } },
    );
    opened.push(worker);
    return runs;
  }

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((closable) => closable.close()));
  });

  afterAll(async () => {
    for (const queue of queuesToClean) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('a first enqueue adds the job and it runs', async () => {
    const { queue, enqueuer } = makeQueue();
    const runs = startWorker(queue);
    const result = await enqueuer.enqueue('order-1');
    expect(result.action).toBe('add');
    expect(result.job.id).toBe('order-1');
    await waitFor(() => runs.length === 1);
  });

  it('re-enqueue after the job COMPLETED runs it again (HELD -> QUEUED release)', async () => {
    const { queue, enqueuer } = makeQueue();
    const runs = startWorker(queue);
    await enqueuer.enqueue('order-1');
    await waitFor(
      async () => (await queue.getJob('order-1').then((j) => j?.getState())) === 'completed',
    );
    expect(runs).toEqual(['order-1']);

    // Control: a plain add() with the same id is silently dropped by BullMQ. This is the bug.
    await queue.add('fulfill', { orderId: 'order-1' }, { jobId: 'order-1' });
    await sleep(300);
    expect(runs).toHaveLength(1);

    const result = await enqueuer.enqueue('order-1');
    expect(result.action).toBe('replace');
    await waitFor(() => runs.length === 2);
    expect(runs).toEqual(['order-1', 'order-1']);
  });

  it('re-enqueue after the job FAILED runs it again (admin retry)', async () => {
    const { queue, enqueuer } = makeQueue();
    const failing = new Set(['order-2']);
    const runs = startWorker(queue, failing);
    await enqueuer.enqueue('order-2');
    await waitFor(
      async () => (await queue.getJob('order-2').then((j) => j?.getState())) === 'failed',
    );
    expect(runs).toHaveLength(1);

    failing.delete('order-2'); // the cause was fixed
    const result = await enqueuer.enqueue('order-2');
    expect(result.action).toBe('replace');
    await waitFor(() => runs.length === 2);
    await waitFor(
      async () => (await queue.getJob('order-2').then((j) => j?.getState())) === 'completed',
    );
  });

  it('a duplicate while the job is still WAITING creates no second job', async () => {
    const { queue, enqueuer } = makeQueue(); // no worker: the job stays waiting
    const first = await enqueuer.enqueue('order-3');
    const second = await enqueuer.enqueue('order-3');
    expect(first.action).toBe('add');
    expect(second.action).toBe('keep');
    expect(second.job.id).toBe(first.job.id);
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(1);
    expect(await queue.getJobCountByTypes('completed', 'failed')).toBe(0);
  });

  it('different orders get independent jobs', async () => {
    const { queue, enqueuer } = makeQueue();
    await enqueuer.enqueue('order-a');
    await enqueuer.enqueue('order-b');
    expect(await queue.getJobCountByTypes('waiting')).toBe(2);
  });

  it('concurrent enqueues of one order still end with exactly one job', async () => {
    const { queue, enqueuer } = makeQueue();
    await Promise.all([
      enqueuer.enqueue('order-4'),
      enqueuer.enqueue('order-4'),
      enqueuer.enqueue('order-4'),
    ]);
    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });

  async function totalJobs(queue: Queue): Promise<number> {
    const counts = await queue.getJobCounts();
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  async function completedJob(queue: Queue<FulfillOrderJobData>, enqueuer: FulfillOrderEnqueuer) {
    await enqueuer.enqueue('order-5');
    await waitFor(
      async () => (await queue.getJob('order-5').then((j) => j?.getState())) === 'completed',
    );
  }

  it.each([2, 5])(
    '%i concurrent replaces of a COMPLETED job end with exactly one job and no rejection',
    async (callers) => {
      const { queue, enqueuer } = makeQueue();
      const runs = startWorker(queue);
      await completedJob(queue, enqueuer);
      expect(runs).toHaveLength(1);

      const results = await Promise.allSettled(
        Array.from({ length: callers }, () => enqueuer.enqueue('order-5')),
      );
      expect(results.map((r) => r.status)).toEqual(Array(callers).fill('fulfilled'));
      for (const result of results) {
        if (result.status === 'fulfilled') expect(result.value.job.id).toBe('order-5');
      }
      // The id never exists twice, whatever the interleaving.
      expect(await totalJobs(queue)).toBe(1);
      // The replacement ran, and the run count is bounded by the number of callers.
      await waitFor(() => runs.length >= 2);
      expect(runs.length).toBeLessThanOrEqual(1 + callers);
    },
  );

  it('removing a job that a worker holds throws the error the enqueuer treats as "keep"', async () => {
    const { queue, enqueuer } = makeQueue();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Released at teardown, even when an assertion fails: worker.close() waits for the job.
    opened.push({
      close: () => {
        release();
        return Promise.resolve();
      },
    });
    let started = 0;
    const worker = new Worker<FulfillOrderJobData>(
      queue.name,
      async () => {
        started += 1;
        if (started > 1) await gate; // the first run completes; the replacement blocks
      },
      { connection: { url: env.REDIS_URL, maxRetriesPerRequest: null } },
    );
    opened.push(worker);
    await completedJob(queue, enqueuer);
    // A caller that read the COMPLETED job before somebody else replaced it.
    const stale = await queue.getJob('order-5');
    if (!stale) throw new Error('expected the completed job');

    await enqueuer.enqueue('order-5'); // replaces it; a worker now holds the new job
    await waitFor(
      async () => (await queue.getJob('order-5').then((j) => j?.getState())) === 'active',
    );

    const error = await stale.remove().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isLockedRemovalError(error)).toBe(true);
    expect(isLockedRemovalError(new Error('connection refused'))).toBe(false);
    expect(isLockedRemovalError('locked')).toBe(false);
    // The running job is untouched.
    expect(await queue.getJob('order-5').then((j) => j?.getState())).toBe('active');

    // The enqueuer itself: it read the finished job and decided to replace it, but by the time
    // it calls remove() a concurrent caller has replaced it and a worker holds the new one.
    // That must end as "keep" (the live job), not as a failure after the DB commit.
    jest.spyOn(queue, 'getJob').mockResolvedValueOnce(stale);
    jest.spyOn(stale, 'getState').mockResolvedValueOnce('completed');
    const result = await enqueuer.enqueue('order-5');
    expect(result.action).toBe('keep');
    expect(result.job.id).toBe('order-5');
    expect(await result.job.getState()).toBe('active');
    expect(await totalJobs(queue)).toBe(1);
  });

  it('any other remove() failure still surfaces', async () => {
    const { queue, enqueuer } = makeQueue();
    startWorker(queue);
    await completedJob(queue, enqueuer);
    const finished = await queue.getJob('order-5');
    if (!finished) throw new Error('expected the completed job');
    jest.spyOn(queue, 'getJob').mockResolvedValueOnce(finished);
    jest.spyOn(finished, 'remove').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(enqueuer.enqueue('order-5')).rejects.toThrow('Connection is closed.');
  });
});
