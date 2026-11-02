import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { QUEUES, tgOutboxJobSchema, type TgOutboxJob } from '@repo/shared';
import type { Queue } from 'bullmq';

export const TG_OUTBOX_JOB_NAME = 'send';

/**
 * The one way to put a Telegram message on the outbox.
 *
 * SECURITY: never put an OTP / login code in a job. Jobs stay in Redis for days
 * (QUEUE_JOB_DEFAULTS retention) and are readable by anyone with Redis access; the bot replies
 * with login codes directly inside the update handler instead.
 *
 * Idempotency: `messageId` becomes the BullMQ jobId, and adding an existing jobId is a no-op,
 * so a retried producer (e.g. "order delivered" re-emitted) sends one message. Build it with
 * `tgOutboxJobId('order', orderId, 'delivered')`: it must be stable per logical message and
 * contain no ':' (BullMQ rejects it).
 */
@Injectable()
export class TgOutboxEnqueuer {
  constructor(@InjectQueue(QUEUES.TG_OUTBOX) private readonly queue: Queue) {}

  async enqueue(messageId: string, job: TgOutboxJob): Promise<void> {
    const data = tgOutboxJobSchema.parse(job);
    await this.queue.add(TG_OUTBOX_JOB_NAME, data, { jobId: messageId });
  }
}
