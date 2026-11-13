import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  notifyJobId,
  notifyJobSchema,
  scrubSecretsInText,
  type BankFeedAlertKind,
} from '@repo/shared';
import type { Queue } from 'bullmq';

/**
 * Owner alerts raised by the card services (`adminAction` for every CLI card operation,
 * `cardDraining` when a card stops taking requests; docs/05 §2, §7, alert table §10). The job
 * carries ids only; the text is rendered later from the database. Best effort: the change is
 * already committed, so a Redis hiccup is logged (ids only) instead of failing the command.
 */
@Injectable()
export class PaymentsAlerts {
  private readonly logger = new Logger(PaymentsAlerts.name);

  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue) {}

  async raise(alert: BankFeedAlertKind, refId: string): Promise<string | null> {
    const job = notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert, refId });
    const jobId = notifyJobId(job);
    try {
      await this.queue.add(NOTIFY_JOB_NAME, job, { jobId });
      return jobId;
    } catch (error) {
      // ioredis messages can quote the connection URL (password): scrubbed (I2).
      const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
      this.logger.error(`owner alert ${alert} for ${refId} not queued: ${reason}`);
      return null;
    }
  }
}
