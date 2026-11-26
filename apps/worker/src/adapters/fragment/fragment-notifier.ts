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
import type { NoticeQueue } from '../../ton/ton-notifier';

// Fragment session alerts to the owner (phase 5 S7) through the `notify` queue: the API renders
// `alerts.fulfillment.fragmentSession*` (S6) and sends it via tg-outbox. The refId names the death
// (`<sessionId>_<deadAt epoch ms>`), so the notify job id is stable per death: a repeat (the next
// tick, a second replica) is dropped by BullMQ, and the owner hears once per death and once per
// recovery. Called after the state change committed; a failure is logged, never thrown (the next
// tick sends the same id again while the session stays dead).

export type FragmentAlert = 'fragmentSessionDead' | 'fragmentSessionRestored';

/** The refId of one death of one session. */
export function deathRef(sessionId: string, deadAt: Date): string {
  return `${sessionId}_${String(deadAt.getTime())}`;
}

@Injectable()
export class FragmentNotifier {
  private readonly logger = new Logger(FragmentNotifier.name);

  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: NoticeQueue) {}

  async alert(alert: FragmentAlert, refId: string): Promise<void> {
    const job: NotifyJob = { kind: 'OWNER_ALERT', alert, refId };
    const parsed = notifyJobSchema.safeParse(job);
    if (!parsed.success) {
      this.logger.error(`fragment alert ${alert} has an invalid id: not queued`);
      return;
    }
    const jobId = notifyJobId(parsed.data);
    try {
      await this.queue.add(NOTIFY_JOB_NAME, parsed.data, { jobId });
    } catch (error) {
      this.logger.error(`fragment alert ${alert} not queued: ${describeErrorForLog(error)}`);
    }
  }
}
