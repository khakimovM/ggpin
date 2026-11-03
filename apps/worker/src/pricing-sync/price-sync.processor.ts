import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PRICE_SYNC_JOBS, QUEUES, scrubSecretsInText } from '@repo/shared';
import type { Job } from 'bullmq';
import { CostSyncService, type CostSyncResult } from './cost-sync.service';
import { FxSyncService, type FxSyncResult } from './fx-sync.service';

/**
 * Consumer of the price-sync queue; dispatches on the job name. Default concurrency (1) keeps
 * runs serial inside one worker, and every run only appends immutable rows, so a duplicate run
 * (a second worker, a boot run next to a scheduled one) is harmless.
 */
@Processor(QUEUES.PRICE_SYNC)
export class PriceSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceSyncProcessor.name);

  constructor(
    private readonly fx: FxSyncService,
    private readonly cost: CostSyncService,
  ) {
    super();
  }

  // Only the name is read; typed as such so tests need no full Job.
  process(job: Pick<Job, 'name'>): Promise<FxSyncResult | CostSyncResult> {
    switch (job.name) {
      case PRICE_SYNC_JOBS.FX:
        return this.fx.run();
      case PRICE_SYNC_JOBS.COST:
        return this.cost.run();
      default:
        return Promise.reject(new Error(`unknown price-sync job "${job.name}"`));
    }
  }

  // Cron jobs are not retried (attempts 1): the next tick is the retry. Log the reason here,
  // scrubbed, since a future real source's error could carry a URL with a key.
  @OnWorkerEvent('failed')
  onFailed(job: Pick<Job, 'name'> | undefined, error: Error): void {
    this.logger.error(
      `price-sync job ${job?.name ?? '?'} failed: ${scrubSecretsInText(error.message)}`,
    );
  }
}
