import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { QUEUES, ResourceIdSchema } from '@repo/shared';
import type { Queue } from 'bullmq';
import { z } from 'zod';

export const CARD_LIMIT_JOB_NAME = 'card-limit';

/** `card-limit` job payload: the received CREDIT message's id, nothing else. */
export const cardLimitJobSchema = z.strictObject({ bankMessageId: ResourceIdSchema });
export type CardLimitJob = z.infer<typeof cardLimitJobSchema>;

/** One check per message: `cl-<bankMessageId>` (BullMQ drops a repeat while the job is kept). */
export function cardLimitJobId(bankMessageId: string): string {
  return `cl-${bankMessageId}`;
}

/**
 * Hands a received CREDIT's card-limit check to its own job (`card-limit` queue, queues.ts), so
 * a busy card or a failing check never delays or loses the message's alerts and never spends the
 * bank-message job's attempts (M-1). The job carries the message id only.
 */
@Injectable()
export class CardLimitScheduler {
  constructor(@InjectQueue(QUEUES.CARD_LIMIT) private readonly queue: Queue) {}

  async schedule(bankMessageId: string): Promise<void> {
    const data = cardLimitJobSchema.parse({ bankMessageId });
    await this.queue.add(CARD_LIMIT_JOB_NAME, data, { jobId: cardLimitJobId(bankMessageId) });
  }
}
