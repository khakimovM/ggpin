import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  FULFILL_ORDER_LOCK_DURATION_MS,
  QUEUES,
  ResourceIdSchema,
  describeErrorForLog,
} from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';
import { FulfillEnqueuer } from './fulfill-enqueuer';
import { FulfillOrderService, type RunOutcome } from './fulfill-order.service';
import { isFinalAttempt } from './fulfill-steps';

/** `fulfill-order` payload: the order id only (also the jobId); the order row is the truth. */
export const fulfillOrderJobSchema = z.strictObject({ orderId: ResourceIdSchema });

// `finishedOn` is typed number | undefined, but Job.retry() sets it to null (bullmq job.js).
// `returnvalue` is what process() returned (a completed job): a RunOutcome.
type JobLike = Pick<Job, 'id' | 'data' | 'attemptsMade' | 'opts'> & {
  readonly finishedOn?: number | null;
  readonly returnvalue?: unknown;
};

/**
 * BullMQ will not run this job again: `finishedOn` is set by moveToFailed exactly when no retry
 * follows (the last attempt, an UnrecoverableError, or a job stalled more than maxStalledCount,
 * which BullMQ fails without calling process()); the attempt count is the fallback.
 */
export function isFailedForGood(job: JobLike): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Consumer of `fulfill-order` (jobId = orderId; 5 attempts, exponential 5 s: queues.ts). Thin: the
 * run is FulfillOrderService's. Concurrency 1 in phase 5 (one hot wallet). `lockDuration` is the
 * shared FULFILL_ORDER_LOCK_DURATION_MS (its comment explains why it need not cover the TON wait).
 *
 * End of run (docs/06 "Phase 5 majburiy talablari", safeguard 1): once BullMQ has marked the job
 * finished (completed or failed), the order's status is read again; still QUEUED (released from
 * HELD while this job ran, its enqueue dropped as `keep`) -> enqueued again through the worker's
 * enqueuer. Only now can a new job take the id: during `process` the job is still active.
 * Not after a run that ended BUSY (S9d fix F1): its last retry never took the order, so whoever
 * holds the lease decides it. A live run carries the QUEUED order on itself, and its own end-of-run
 * re-check follows when its job completes; a stalled duplicate's holder may never fire that
 * `completed` event, and then the order is the stale step's (job-less and unchanged for
 * ORDER_STALE_AFTER_MS: 10 to 20 minutes with the 10-minute tick). A poisoned lease would only make
 * the new job meet BUSY again, for ever, and keep a job alive that hides the lease. Left job-less, the order is the reconciler's: queued
 * again once the lease is gone (stale step), or the owner's alert while it stays (lock step).
 * A job that failed FOR GOOD (CR M1) is settled instead: its order never stays silent
 * (FulfillOrderService.settleAbandoned, fulfill-settle.ts).
 * Logs carry the order id and an error description only (describeErrorForLog), never secrets.
 */
@Processor(QUEUES.FULFILL_ORDER, {
  concurrency: 1,
  lockDuration: FULFILL_ORDER_LOCK_DURATION_MS,
})
export class FulfillOrderProcessor extends WorkerHost {
  private readonly logger = new Logger(FulfillOrderProcessor.name);

  constructor(
    private readonly service: FulfillOrderService,
    private readonly enqueuer: FulfillEnqueuer,
  ) {
    super();
  }

  async process(job: JobLike): Promise<RunOutcome> {
    const parsed = fulfillOrderJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid fulfill-order payload');
    const { orderId } = parsed.data;
    const finalAttempt = isFinalAttempt(job.attemptsMade, job.opts.attempts);
    try {
      const outcome = await this.service.run(orderId, { finalAttempt });
      this.logger.log(`fulfill-order ${orderId}: ${outcome}`);
      return outcome;
    } catch (error) {
      const attempt = String(job.attemptsMade + 1);
      this.logger.warn(
        `fulfill-order ${orderId}: attempt ${attempt} failed: ${describeErrorForLog(error)}`,
      );
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: JobLike): Promise<void> {
    return this.requeueIfQueued(job);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: JobLike | undefined): Promise<void> {
    if (job === undefined) return;
    if (!isFailedForGood(job)) return this.requeueIfQueued(job);
    const parsed = fulfillOrderJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    const outcome = await this.service.settleAbandoned(parsed.data.orderId);
    this.logger.warn(`fulfill-order ${parsed.data.orderId}: failed for good, settled: ${outcome}`);
  }

  /** Safeguard 1; never throws (an event handler error would be unhandled). */
  async requeueIfQueued(job: JobLike): Promise<void> {
    const parsed = fulfillOrderJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    if (job.returnvalue === 'BUSY') return; // F1: the lease's holder decides (see the class doc)
    const { orderId } = parsed.data;
    try {
      if ((await this.service.statusOf(orderId)) !== 'QUEUED') return;
      const action = await this.enqueuer.enqueue(orderId);
      this.logger.log(`fulfill-order ${orderId}: still QUEUED after the run, enqueue ${action}`);
    } catch (error) {
      // The reconcile sweep (safeguard 2, S9) re-queues a QUEUED order without a job.
      this.logger.error(
        `fulfill-order ${orderId}: end-of-run re-check failed: ${describeErrorForLog(error)}`,
      );
    }
  }
}
