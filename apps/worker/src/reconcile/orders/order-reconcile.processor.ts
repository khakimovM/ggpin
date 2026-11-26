import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES, describeErrorForLog } from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { ORDER_RECONCILE_JOB_NAME } from './order-reconcile.scheduler';
import { OrderReconcileService } from './order-reconcile.service';

/** The job's result: the counts per step (ids stay in the log). */
export interface OrderReconcileJobResult {
  readonly steps: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly failed: readonly string[];
}

type JobLike = Pick<Job, 'id' | 'name'>;

/**
 * Consumer of the `reconcile` queue (cron defaults: one attempt, the next tick is the retry).
 * Thin: `orders` runs one tick of OrderReconcileService; any other name fails at once without
 * spending an attempt. Concurrency 1: two ticks never overlap in one process; two worker processes
 * may overlap, which the order locks and the database compare-and-set make harmless.
 */
@Processor(QUEUES.RECONCILE, { concurrency: 1 })
export class OrderReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderReconcileProcessor.name);

  constructor(private readonly reconcile: OrderReconcileService) {
    super();
  }

  async process(job: JobLike): Promise<OrderReconcileJobResult> {
    if (job.name !== ORDER_RECONCILE_JOB_NAME) {
      // A wrong name never becomes right on a retry.
      throw new UnrecoverableError(`unknown reconcile job "${job.name}"`);
    }
    const report = await this.reconcile.tick();
    return {
      steps: Object.fromEntries(report.steps.map((step) => [step.step, step.counts])),
      failed: report.failed,
    };
  }

  @OnWorkerEvent('failed')
  onFailed(job: JobLike | undefined, error: Error): void {
    this.logger.warn(
      `reconcile job=${job?.id ?? '?'} name=${job?.name ?? '?'} failed: ${describeErrorForLog(error, 200)}`,
    );
  }
}
