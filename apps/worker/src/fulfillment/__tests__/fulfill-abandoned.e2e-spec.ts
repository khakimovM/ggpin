import { setTimeout as sleep } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import { pinChain } from '../../ton/__tests__/ton-e2e.harness';
import type { TonPayResult } from '../../ton/ton-payout';
import { MAX_ABANDONED_REQUEUES } from '../abandon-counter';
import { AttemptsRepository } from '../attempts.repository';
import { FulfillOrderProcessor } from '../fulfill-order.processor';
import { abandonedAlertRef } from '../fulfill-settle';
import { OrderStateRepository } from '../order-state.repository';
import { attemptsOf, orderRow } from './fulfill-e2e.fixtures';
import { GrantingLockStore, useFulfillE2e, type FulfillInstance } from './fulfill-e2e.harness';

// A fulfill-order job that failed FOR GOOD never leaves its order silent (S4 CR M1, audit M-1,
// probe A): the last attempt threw, or BullMQ failed the job without running it (a crash loop:
// stalled more than maxStalledCount). Real BullMQ Workers on a queue of this suite only, with
// short lock and stall settings; the processor's own `process` and `onFailed` run inside them.

const t = useFulfillE2e();
const QUEUE = 'fulfill-order-s4-abandoned-test';
const FAST = { lockDuration: 600, stalledInterval: 300, maxStalledCount: 1 } as const;

const reviewJobs = (orderId: string) => [
  { kind: 'ORDER_REVIEW' as const, refId: orderId },
  { kind: 'OWNER_ALERT' as const, alert: 'needsReview' as const, refId: orderId },
];

async function expectReviewed(orderId: string): Promise<void> {
  expect(await orderRow(t.db, orderId)).toEqual(
    expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
  );
  expect((await attemptsOf(t.db, orderId)).map((a) => a.status)).toEqual(['UNKNOWN']);
  for (const job of reviewJobs(orderId)) expect(await t.hasJob(job)).toBe(true);
  expect(t.gateway.callCount('sendBoc')).toBe(0);
}

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 15_000; waited += 50) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function processorOf(instance: FulfillInstance): FulfillOrderProcessor {
  return new FulfillOrderProcessor(instance.service, instance.enqueuer);
}

afterEach(() => jest.restoreAllMocks());

describe('fulfill-order: a job that failed for good is settled (no BullMQ Worker)', () => {
  it('probe A: a throw after SENDING on the last attempt -> NEEDS_REVIEW + alerts', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.main.hooks.afterSendingFn = () => Promise.reject(new Error('process died here'));
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).rejects.toThrow(
      'process died here',
    );
    await expectReviewed(fixture.orderId);
    // BullMQ's failed event after the last attempt: the settled order is only replayed.
    await expect(t.main.service.settleAbandoned(fixture.orderId)).resolves.toBe('REPLAYED');
  });

  it('a lost SENDING commit on the last attempt: nothing was written -> HELD (core hold)', async () => {
    const fixture = await t.order();
    const attempts = t.main.moduleRef.get(AttemptsRepository);
    jest.spyOn(attempts, 'createSending').mockRejectedValueOnce(new Error('connection reset'));
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).rejects.toThrow(
      'connection reset',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    const event = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: fixture.orderId, to: 'HELD' },
    });
    const ref = `${fixture.orderId}_${event.id}`;
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'held', refId: ref })).toBe(true);
  });

  it('a SENDING commit whose answer was lost: the attempt exists -> NEEDS_REVIEW', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    const attempts = t.main.moduleRef.get(AttemptsRepository);
    const original = attempts.createSending.bind(attempts);
    jest.spyOn(attempts, 'createSending').mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error('the answer was lost');
    });
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).rejects.toThrow(
      'the answer was lost',
    );
    await expectReviewed(fixture.orderId);
  });

  it('nothing can be written: the owner hears (<orderId>_abandoned), the later review too', async () => {
    const fixture = await t.order();
    t.main.hooks.afterSendingFn = () => Promise.reject(new Error('died'));
    const attempts = t.main.moduleRef.get(AttemptsRepository);
    jest.spyOn(attempts, 'toReview').mockRejectedValue(new Error('database down'));
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).rejects.toThrow(
      'died',
    );
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PROCESSING');
    const alert = { kind: 'OWNER_ALERT' as const, alert: 'needsReview' as const };
    expect(await t.hasJob({ ...alert, refId: abandonedAlertRef(fixture.orderId) })).toBe(true);
    // The plain order id stays free (S4 re-review R1): notify ids dedupe, so sharing it would
    // swallow the real NEEDS_REVIEW alert below.
    expect(await t.hasJob({ ...alert, refId: fixture.orderId })).toBe(false);
    jest.restoreAllMocks();
    await expect(t.main.service.settleAbandoned(fixture.orderId)).resolves.toBe('REVIEW');
    await expectReviewed(fixture.orderId);
  });

  it(`PAID / QUEUED: enqueued again ${String(MAX_ABANDONED_REQUEUES)} times, then the owner hears`, async () => {
    const fixture = await t.order();
    for (let round = 1; round <= MAX_ABANDONED_REQUEUES; round += 1) {
      await (await t.fulfillQueue.getJob(fixture.orderId))?.remove();
      await expect(t.main.service.settleAbandoned(fixture.orderId)).resolves.toBe('REQUEUED');
      expect(await t.fulfillQueue.getJob(fixture.orderId)).toBeDefined();
    }
    const alert = { kind: 'OWNER_ALERT', alert: 'needsReview' } as const;
    const ref = abandonedAlertRef(fixture.orderId);
    expect(await t.hasJob({ ...alert, refId: ref })).toBe(false);
    await expect(t.main.service.settleAbandoned(fixture.orderId)).resolves.toBe('ALERTED');
    expect(await t.hasJob({ ...alert, refId: ref })).toBe(true);
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PAID');
  });

  it('a last attempt that throws on PAID counts once per failure (R2: not run + failed event)', async () => {
    const fixture = await t.order();
    const orders = t.main.moduleRef.get(OrderStateRepository);
    jest.spyOn(orders, 'advance').mockRejectedValue(new Error('connection reset'));
    const failForGood = async () => {
      await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).rejects.toThrow(
        'connection reset',
      );
      // Inside the run the job is still active: nothing enqueued, nothing counted (DEFERRED).
      expect(await t.fulfillQueue.getJob(fixture.orderId)).toBeUndefined();
      // The failed event that follows (onFailed -> settleAbandoned).
      return t.main.service.settleAbandoned(fixture.orderId);
    };
    for (let round = 1; round <= MAX_ABANDONED_REQUEUES; round += 1) {
      await (await t.fulfillQueue.getJob(fixture.orderId))?.remove();
      await expect(failForGood()).resolves.toBe('REQUEUED');
    }
    await (await t.fulfillQueue.getJob(fixture.orderId))?.remove();
    await expect(failForGood()).resolves.toBe('ALERTED');
    const alert = { kind: 'OWNER_ALERT', alert: 'needsReview' } as const;
    expect(await t.hasJob({ ...alert, refId: abandonedAlertRef(fixture.orderId) })).toBe(true);
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PAID');
  });
});

describe('fulfill-order: real BullMQ Workers', () => {
  const workers: Worker[] = [];
  let queue: Queue;

  beforeEach(() => {
    queue = new Queue(QUEUE, { connection: { url: t.env.REDIS_URL } });
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close(true);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  function worker(handler: (job: Job) => Promise<unknown>, onFailed?: (job: Job) => Promise<void>) {
    const created = new Worker(QUEUE, handler, { connection: { url: t.env.REDIS_URL }, ...FAST });
    if (onFailed !== undefined) created.on('failed', (job) => void (job && onFailed(job)));
    workers.push(created);
    return created;
  }

  it('a crash loop (stalled twice): failed without process(), the order goes to review', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    // The "process" that dies: its payout never answers, its order lock is not Redis's.
    let release: (error: Error) => void = () => undefined;
    const hang = new Promise<TonPayResult>((_resolve, reject) => {
      release = reject;
    });
    const dying = await t.boot({ lockStore: new GrantingLockStore(), payer: { pay: () => hang } });
    const settling = await t.boot();
    let started = 0;
    const run = (job: Job) => {
      started += 1;
      return processorOf(dying).process(job);
    };
    let settled: Promise<void> | undefined;
    const onFailed = (job: Job) => (settled = processorOf(settling).onFailed(job));
    await queue.add(
      'fulfill',
      { orderId: fixture.orderId },
      { jobId: fixture.orderId, attempts: 5 },
    );

    const first = worker(run);
    await until('the first run', () => Promise.resolve(started >= 1));
    await first.close(true);
    const second = worker(run);
    await until('the stalled job to run again', () => Promise.resolve(started >= 2));
    await second.close(true);
    worker(() => Promise.reject(new Error('process() must not run')), onFailed);
    await until('the failed event', () => Promise.resolve(settled !== undefined));
    await settled;

    const job = await queue.getJob(fixture.orderId);
    expect(job?.failedReason).toBe('job stalled more than allowable limit');
    expect(started).toBe(2);
    await expectReviewed(fixture.orderId);
    release(new Error('the dead process is gone'));
  });

  it('the last attempt throws inside a Worker: settled before the job fails', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.main.hooks.afterSendingFn = () => Promise.reject(new Error('process died here'));
    const processor = processorOf(t.main);
    let settled: Promise<void> | undefined;
    worker(
      (job) => processor.process(job),
      (job) => (settled = processor.onFailed(job)),
    );
    await queue.add(
      'fulfill',
      { orderId: fixture.orderId },
      { jobId: fixture.orderId, attempts: 1 },
    );
    await until('the failed event', () => Promise.resolve(settled !== undefined));
    await settled;
    expect((await queue.getJob(fixture.orderId))?.failedReason).toBe('process died here');
    await expectReviewed(fixture.orderId);
  });
});
