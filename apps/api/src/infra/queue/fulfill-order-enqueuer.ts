import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { decideEnqueue, QUEUES, type EnqueueAction, type FulfillOrderJobData } from '@repo/shared';
import type { Job, Queue } from 'bullmq';

export const FULFILL_ORDER_JOB_NAME = 'fulfill';

export interface EnqueueResult {
  readonly action: EnqueueAction;
  readonly job: Job<FulfillOrderJobData>;
}

/**
 * The one way to enqueue fulfill-order (`jobId = orderId`). A plain `queue.add` loses a second,
 * legitimate enqueue while the first job is still retained as completed/failed, so we look the
 * job up and let `decideEnqueue` choose. Call it AFTER the transaction that moved the order to
 * QUEUED has committed.
 *
 * Not a double-spend guard: that is the order lock + status re-check in the processor. This
 * class only makes sure a needed run is not silently dropped.
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
    if (existing && action === 'replace') await existing.remove();

    // `add` is still idempotent on the id: if a concurrent enqueue slipped in between our
    // lookup and this call, BullMQ returns that job instead of creating a second one.
    const job = await this.queue.add(FULFILL_ORDER_JOB_NAME, { orderId }, { jobId: orderId });
    return { action, job };
  }
}
