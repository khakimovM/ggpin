import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import type { Job } from 'bullmq';
import { TopupExpireService, type TopupExpireResult } from './topup-expire.service';

/**
 * Consumer of `topup-expire` (every minute, attempts 1: the next tick is the retry; queues.ts).
 * Logs counts only.
 */
@Processor(QUEUES.TOPUP_EXPIRE, { concurrency: 1 })
export class TopupExpireProcessor extends WorkerHost {
  private readonly logger = new Logger(TopupExpireProcessor.name);

  constructor(private readonly sweep: TopupExpireService) {
    super();
  }

  async process(): Promise<TopupExpireResult> {
    const result = await this.sweep.run(new Date());
    const busy =
      result.expired +
      result.madeFull +
      result.skippedCards +
      result.retiredCards +
      result.drainHeldByMessage +
      result.drainAlertsFailed +
      result.requeuedMessages +
      result.silentAlerts +
      result.silentAlertsFailed;
    if (busy > 0) {
      this.logger.log(
        `topup-expire expired=${String(result.expired)} madeFull=${String(result.madeFull)} ` +
          `limitAlerts=${String(result.limitAlerts)} skippedCards=${String(result.skippedCards)} ` +
          `retiredCards=${String(result.retiredCards)} ` +
          `drainHeldByMessage=${String(result.drainHeldByMessage)} ` +
          `drainAlertsFailed=${String(result.drainAlertsFailed)} ` +
          `requeuedMessages=${String(result.requeuedMessages)} ` +
          `silentAlerts=${String(result.silentAlerts)} ` +
          `silentAlertsFailed=${String(result.silentAlertsFailed)}`,
      );
    }
    return result;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Pick<Job, 'id'> | undefined, error: Error): void {
    this.logger.warn(`topup-expire job=${job?.id ?? '?'} failed: ${error.name}`);
  }
}
