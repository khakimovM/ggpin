import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { decideEnqueue, QUEUES, type EnqueueAction, type FulfillOrderJobData } from '@repo/shared';
import type { Job, Queue } from 'bullmq';

export const FULFILL_ORDER_JOB_NAME = 'fulfill';

export interface EnqueueResult {
  readonly action: EnqueueAction;
  readonly job: Job<FulfillOrderJobData>;
}

// BullMQ has no error class for this case; `Job.remove()` throws a plain Error with this text
// (bullmq/dist/cjs/classes/job.js) when the job id is locked by a worker. Matched narrowly:
// any OTHER failure of remove() (Redis down, ...) must still surface to the caller.
const LOCKED_REMOVAL = /could not be removed because it is locked by another worker/;

export function isLockedRemovalError(error: unknown): boolean {
  return error instanceof Error && LOCKED_REMOVAL.test(error.message);
}

/**
 * The one way to enqueue fulfill-order (`jobId = orderId`). A plain `queue.add` loses a second,
 * legitimate enqueue while the first job is still retained as completed/failed, so we look the
 * job up and let `decideEnqueue` choose. Call it AFTER the transaction that moved the order to
 * QUEUED has committed.
 *
 * Not a double-spend guard: that is the order lock + status re-check in the processor. This
 * class only makes sure a needed run is not silently dropped, and it does not promise more
 * than it can:
 * - `keep` for an `active` job is NOT always a true duplicate. An enqueue that arrives while
 *   the previous run is still finishing (HELD released before the job that set HELD is marked
 *   completed) is dropped here, and nothing will run the order again. Closing that gap is a
 *   phase-5 requirement of the processor and a reconcile sweep, see docs/06-FULFILLMENT.md
 *   "Phase 5 majburiy talablari".
 * - Two concurrent callers may both see the same finished job. Whoever removes it first wins;
 *   the other either finds it gone or finds the replacement locked by a worker, and in both
 *   cases ends with exactly one job and no error.
 */
@Injectable()
export class FulfillOrderEnqueuer {
  constructor(
    @InjectQueue(QUEUES.FULFILL_ORDER)
    private readonly queue: Queue<FulfillOrderJobData>,
  ) {}

  async enqueue(orderId: string): Promise<EnqueueResult> {
    const existing = await this.queue.getJob(orderId);
    const action = decideEnqueue(existing ? await existing.getState() : undefined);

    if (existing && action === 'keep') return { action, job: existing };
    if (existing && action === 'replace') {
      const kept = await this.removeFinished(existing, orderId);
      if (kept) return { action: 'keep', job: kept };
    }

    // `add` is still idempotent on the id: if a concurrent enqueue slipped in between our
    // lookup and this call, BullMQ returns that job instead of creating a second one.
    const job = await this.queue.add(FULFILL_ORDER_JOB_NAME, { orderId }, { jobId: orderId });
    return { action, job };
  }

  // Returns the live job to keep when someone else replaced the finished one first and a
  // worker already holds it (its lock makes remove() throw); undefined when we may add.
  private async removeFinished(
    finished: Job<FulfillOrderJobData>,
    orderId: string,
  ): Promise<Job<FulfillOrderJobData> | undefined> {
    try {
      await finished.remove();
      return undefined;
    } catch (error) {
      if (!isLockedRemovalError(error)) throw error;
      return this.queue.getJob(orderId);
    }
  }
}
