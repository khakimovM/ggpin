import { FULFILL_ORDER_LOCK_DURATION_MS } from '@repo/shared';
import { UnrecoverableError } from 'bullmq';
import type { FulfillEnqueuer } from '../fulfill-enqueuer';
import type { FulfillOrderService } from '../fulfill-order.service';
import { FulfillOrderProcessor, isFailedForGood } from '../fulfill-order.processor';

const ORDER = 'cm9orderid000000000000001';

function setup() {
  const run = jest.fn<
    ReturnType<FulfillOrderService['run']>,
    Parameters<FulfillOrderService['run']>
  >();
  const statusOf = jest.fn<
    ReturnType<FulfillOrderService['statusOf']>,
    Parameters<FulfillOrderService['statusOf']>
  >();
  const settleAbandoned = jest.fn<
    ReturnType<FulfillOrderService['settleAbandoned']>,
    Parameters<FulfillOrderService['settleAbandoned']>
  >();
  const enqueue = jest.fn<
    ReturnType<FulfillEnqueuer['enqueue']>,
    Parameters<FulfillEnqueuer['enqueue']>
  >();
  const service = { run, statusOf, settleAbandoned } as Pick<
    FulfillOrderService,
    'run' | 'statusOf' | 'settleAbandoned'
  >;
  const enqueuer = { enqueue } as Pick<FulfillEnqueuer, 'enqueue'>;
  const processor = new FulfillOrderProcessor(
    service as FulfillOrderService,
    enqueuer as FulfillEnqueuer,
  );
  processor['logger'].log = jest.fn();
  processor['logger'].warn = jest.fn();
  processor['logger'].error = jest.fn();
  return { processor, run, statusOf, settleAbandoned, enqueue };
}

const job = (
  attemptsMade: number,
  data: unknown = { orderId: ORDER },
  finishedOn?: number | null,
) => ({
  id: ORDER,
  data,
  attemptsMade,
  opts: { attempts: 5 },
  ...(finishedOn === undefined ? {} : { finishedOn }),
});

describe('FulfillOrderProcessor', () => {
  it('runs with the shared lockDuration and concurrency 1 (one hot wallet)', () => {
    const options: unknown = Reflect.getMetadata('bullmq:worker_metadata', FulfillOrderProcessor);
    expect(options).toEqual({ concurrency: 1, lockDuration: FULFILL_ORDER_LOCK_DURATION_MS });
    expect(FULFILL_ORDER_LOCK_DURATION_MS).toBe(240_000);
  });

  it('refuses a payload that is not exactly { orderId } (no retries)', async () => {
    const { processor, run } = setup();
    await expect(processor.process(job(0, { orderId: ORDER, extra: 1 }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(processor.process(job(0, { orderId: 'bad id' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('tells the service whether this is the last attempt; errors go back to BullMQ', async () => {
    const { processor, run } = setup();
    run.mockResolvedValueOnce('DONE');
    await expect(processor.process(job(3))).resolves.toBe('DONE');
    expect(run).toHaveBeenLastCalledWith(ORDER, { finalAttempt: false });
    run.mockRejectedValueOnce(new Error('pre-send failure'));
    await expect(processor.process(job(4))).rejects.toThrow('pre-send failure');
    expect(run).toHaveBeenLastCalledWith(ORDER, { finalAttempt: true });
  });

  it('end of run: re-enqueues an order that is still QUEUED, nothing else, never throws', async () => {
    const { processor, statusOf, enqueue } = setup();
    statusOf.mockResolvedValueOnce('QUEUED');
    enqueue.mockResolvedValueOnce('replace');
    await processor.onCompleted(job(0));
    expect(enqueue).toHaveBeenCalledWith(ORDER);

    statusOf.mockResolvedValueOnce('HELD');
    await processor.onFailed(job(3));
    expect(enqueue).toHaveBeenCalledTimes(1);

    statusOf.mockRejectedValueOnce(new Error('db down'));
    await expect(processor.onCompleted(job(0))).resolves.toBeUndefined();
    await expect(processor.onFailed(undefined)).resolves.toBeUndefined();
  });

  it('a job failed for good (last attempt, or stalled: finishedOn) is settled, not left silent', async () => {
    const { processor, settleAbandoned, statusOf } = setup();
    settleAbandoned.mockResolvedValue('REVIEW');
    // BullMQ counted the last attempt: attemptsMade = attempts.
    await processor.onFailed(job(5));
    // Stalled more than maxStalledCount: failed without process(), attemptsMade unchanged.
    await processor.onFailed(job(1, { orderId: ORDER }, Date.now()));
    expect(settleAbandoned.mock.calls).toEqual([[ORDER], [ORDER]]);
    expect(statusOf).not.toHaveBeenCalled();
    // A retry follows: only the end-of-run re-check.
    statusOf.mockResolvedValueOnce('PROCESSING');
    await processor.onFailed(job(2));
    expect(settleAbandoned).toHaveBeenCalledTimes(2);
    // An invalid payload has no order to settle.
    await processor.onFailed(job(5, { orderId: 'bad id' }));
    expect(settleAbandoned).toHaveBeenCalledTimes(2);
  });

  it('isFailedForGood: finishedOn, or the attempt count reached', () => {
    expect(isFailedForGood(job(4))).toBe(false);
    expect(isFailedForGood(job(5))).toBe(true);
    expect(isFailedForGood(job(0, {}, 1))).toBe(true);
    // Job.retry() leaves finishedOn = null: a retried job is not failed for good.
    expect(isFailedForGood(job(4, {}, null))).toBe(false);
  });
});
