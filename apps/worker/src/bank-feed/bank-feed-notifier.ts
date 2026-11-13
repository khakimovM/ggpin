import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  notifyJobId,
  notifyJobSchema,
  type BankFeedAlertKind,
  type NotifyJob,
} from '@repo/shared';
import type { Queue } from 'bullmq';

/**
 * Worker -> API notifications (`notify` queue, notify.ts in shared). Jobs carry ids only: the
 * API reads amounts and the language from the database and renders the text, so neither a
 * message text nor money sits in Redis. The job id is stable per logical event, so the replayed
 * effects of an already-processed message add nothing. Errors propagate: the bank-message job
 * then retries and replays the effects.
 */
@Injectable()
export class BankFeedNotifier {
  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue) {}

  alert(alert: BankFeedAlertKind, refId: string): Promise<void> {
    return this.add({ kind: 'OWNER_ALERT', alert, refId });
  }

  topupCredited(paymentId: string, late: boolean): Promise<void> {
    return this.add({ kind: late ? 'TOPUP_LATE_CREDITED' : 'TOPUP_CREDITED', refId: paymentId });
  }

  private async add(job: NotifyJob): Promise<void> {
    const data = notifyJobSchema.parse(job);
    await this.queue.add(NOTIFY_JOB_NAME, data, { jobId: notifyJobId(data) });
  }
}
