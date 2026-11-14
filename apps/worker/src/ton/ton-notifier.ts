import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  notifyJobId,
  notifyJobSchema,
  type NotifyJob,
} from '@repo/shared';
import { errorKind } from './ton-db-errors';
import { noticeJob, type TonNotice } from './ton-notices';

/** The part of the `notify` queue the module uses (BullMQ's Queue; a printer in the self-test). */
export interface NoticeQueue {
  add(name: string, data: NotifyJob, options: { readonly jobId: string }): Promise<unknown>;
}

/**
 * Worker -> API notifications of the TON module (`notify` queue; ids only, the API renders the
 * text, S6). Called AFTER the state change committed: a failure here must not turn a decided
 * payout into an error of the job (rules/45: nothing throws after SENDING), so it is logged with
 * the job id and the next replay re-adds the same id (the notices come from the final rows).
 */
@Injectable()
export class TonNotifier {
  private readonly logger = new Logger(TonNotifier.name);

  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: NoticeQueue) {}

  async send(notices: readonly TonNotice[]): Promise<void> {
    for (const notice of notices) {
      const parsed = notifyJobSchema.safeParse(noticeJob(notice));
      if (!parsed.success) {
        this.logger.error(`ton notice ${notice.kind} has an invalid id: not queued`);
        continue;
      }
      const jobId = notifyJobId(parsed.data);
      try {
        await this.queue.add(NOTIFY_JOB_NAME, parsed.data, { jobId });
      } catch (error) {
        this.logger.error(`ton notice ${jobId} not queued: ${errorKind(error)}`);
      }
    }
  }
}
