import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  QUEUES,
  decideEnqueue,
  type EnqueueAction,
  type FulfillOrderJobData,
  type JobStateName,
} from '@repo/shared';

/** The parts of a BullMQ job and queue the enqueuer uses (BullMQ's own; fakes in unit tests). */
export interface EnqueuedJob {
  getState(): Promise<JobStateName>;
  remove(): Promise<void>;
}

export interface FulfillQueue {
  getJob(jobId: string): Promise<EnqueuedJob | undefined>;
  add(
    name: string,
    data: FulfillOrderJobData,
    options: { readonly jobId: string },
  ): Promise<unknown>;
}

/** The job name the API uses for fulfill-order (apps/api FulfillOrderEnqueuer). */
export const FULFILL_ORDER_JOB_NAME = 'fulfill';

// bullmq/dist/cjs/classes/job.js: Job.remove() of a job locked by a worker. Matched narrowly, any
// other failure (Redis down...) still surfaces.
const LOCKED_REMOVAL = /could not be removed because it is locked by another worker/;

export function isLockedRemovalError(error: unknown): boolean {
  return error instanceof Error && LOCKED_REMOVAL.test(error.message);
}

/**
 * A job that will still run, or is running: waiting, delayed, prioritized, active (the very states
 * the enqueue keeps). `active` counts too: its run holds or is about to take the order lock.
 */
export function isLiveJobState(state: JobStateName): boolean {
  return decideEnqueue(state) === 'keep';
}

/**
 * The worker's one way to enqueue fulfill-order (`jobId = orderId`, docs/06 "Phase 5 majburiy
 * talablari" safeguard 3): the same decision as the API's enqueuer (`decideEnqueue`, shared). A
 * plain `queue.add` would be dropped silently while a finished job still holds the id. Not a
 * double-spend guard: that is the order lock plus the status re-check in the processor.
 */
@Injectable()
export class FulfillEnqueuer {
  constructor(@InjectQueue(QUEUES.FULFILL_ORDER) private readonly queue: FulfillQueue) {}

  async enqueue(orderId: string): Promise<EnqueueAction> {
    const existing = await this.queue.getJob(orderId);
    const action = decideEnqueue(existing ? await existing.getState() : undefined);
    if (existing && action === 'keep') return action;
    if (existing && action === 'replace' && (await this.removeFinished(existing))) return 'keep';
    // Still idempotent on the id: a concurrent enqueue that slipped in is returned, not doubled.
    await this.queue.add(FULFILL_ORDER_JOB_NAME, { orderId }, { jobId: orderId });
    return action;
  }

  /**
   * The state of the order's job, `unknown` when there is none. Read only: the order reconciler
   * (phase 5 S9d) leaves an order alone while its job lives, and never touches the queue itself.
   */
  async stateOf(orderId: string): Promise<JobStateName> {
    const job = await this.queue.getJob(orderId);
    return job === undefined ? 'unknown' : job.getState();
  }

  /** True when someone else replaced the finished job first and a worker holds the new one. */
  private async removeFinished(finished: EnqueuedJob): Promise<boolean> {
    try {
      await finished.remove();
      return false;
    } catch (error) {
      if (!isLockedRemovalError(error)) throw error;
      return true;
    }
  }
}
