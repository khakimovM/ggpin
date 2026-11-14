import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  notifyJobId,
  notifyJobSchema,
  type OrderNotifyKind,
} from '@repo/shared';
import type { Queue } from 'bullmq';

/**
 * Tells the customer about their order (`ORDER_ACCEPTED` from the purchase; rendered by
 * OrderNotifyRenderer via the notify consumer). The job carries the order id only: the product,
 * the amount and the recipient are read from the database when it is rendered, so nothing about
 * the purchase sits in Redis. Job id = `order-<orderId>-<kind>`: a replayed purchase (D-49) or a
 * second call adds nothing while the first job is kept.
 */
@Injectable()
export class OrderNotifyProducer {
  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue) {}

  async enqueue(kind: OrderNotifyKind, orderId: string): Promise<void> {
    const job = notifyJobSchema.parse({ kind, refId: orderId });
    await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
  }
}
