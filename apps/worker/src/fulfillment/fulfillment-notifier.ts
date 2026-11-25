import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
  type NotifyJob,
} from '@repo/shared';
import { noticeJob, type TonNotice } from '../ton/ton-notices';
import type { NoticeQueue } from '../ton/ton-notifier';

// Worker -> API notifications of the fulfillment core (`notify` queue; ids only, the API renders
// the text in uz/ru, S6). Called AFTER the state change committed. A failure is logged, never
// thrown: the decided outcome must not turn into a job error (nothing throws after SENDING), and
// the next replay of the job re-adds the same ids (notices come from the order's final state).

@Injectable()
export class FulfillmentNotifier {
  private readonly logger = new Logger(FulfillmentNotifier.name);

  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: NoticeQueue) {}

  async send(notices: readonly TonNotice[]): Promise<void> {
    for (const notice of notices) await this.add(noticeJob(notice));
  }

  async refunded(orderId: string): Promise<void> {
    await this.add({ kind: 'ORDER_REFUNDED', refId: orderId });
  }

  private async add(job: NotifyJob): Promise<void> {
    const parsed = notifyJobSchema.safeParse(job);
    if (!parsed.success) {
      this.logger.error(`fulfillment notice ${job.kind} has an invalid id: not queued`);
      return;
    }
    const jobId = notifyJobId(parsed.data);
    try {
      await this.queue.add(NOTIFY_JOB_NAME, parsed.data, { jobId });
    } catch (error) {
      this.logger.error(`fulfillment notice ${jobId} not queued: ${describeErrorForLog(error)}`);
    }
  }
}
