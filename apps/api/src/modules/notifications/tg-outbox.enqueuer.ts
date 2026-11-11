import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { QUEUES, tgOutboxJobSchema, type TgOutboxJob } from '@repo/shared';
import type { Queue } from 'bullmq';

export const TG_OUTBOX_JOB_NAME = 'send';

/**
 * The one way to put a Telegram message on the outbox.
 *
 * SECURITY: never put an OTP / login code in an `enqueue` job. Those jobs stay in Redis for days
 * (QUEUE_JOB_DEFAULTS retention) and are readable by anyone with Redis access; the bot replies
 * with login codes directly inside the update handler instead. The one exception is the owner's
 * confirmation code of the owner CLI (D-46): it goes through `enqueueEphemeral`, whose job is
 * deleted as soon as it is sent or finally fails, and the CLI `discard`s it when it is done.
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

  /** A message that must not outlive its sending (an owner code): no retention at all. */
  async enqueueEphemeral(messageId: string, job: TgOutboxJob): Promise<void> {
    const data = tgOutboxJobSchema.parse(job);
    await this.queue.add(TG_OUTBOX_JOB_NAME, data, {
      jobId: messageId,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** Removes a job that is still waiting or delayed (a job being sent right now stays). */
  async discard(messageId: string): Promise<void> {
    await this.queue.remove(messageId);
  }
}
