import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES, tashkentDayKey } from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { BankFeedNotifier } from '../bank-feed/bank-feed-notifier';
import { BankTextPurgeService, type BankTextPurgeResult } from './bank-text-purge.service';
import {
  BANK_TEXT_PURGE_JOB_NAME,
  PAYMENT_RECONCILE_JOB_NAME,
} from './payment-reconcile.scheduler';
import { PaymentReconcileService } from './payment-reconcile.service';

export interface PaymentReconcileJobResult {
  readonly day: string;
  readonly auditId: string;
  readonly ok: boolean;
}

type JobLike = Pick<Job, 'id' | 'name' | 'attemptsMade' | 'opts'>;

/**
 * Consumer of `payment-reconcile` (daily; 3 attempts, 60 s exponential: queues.ts), dispatching
 * on the job name:
 * - `daily`: the reconciliation. A retry only re-reads and writes another audit row. When the
 *   LAST attempt fails the owner gets `reconcileFailed` (refId = the Tashkent day of the run),
 *   sent without any database read or write, so a broken reconciliation is never silent (S9 M2).
 * - `bank-text-purge`: the raw-text retention purge (BankTextPurgeService), idempotent, so a
 *   retry or the next day finishes what a failed run left; a failure is logged, no alert.
 * Logs: the verdict and counts, an error NAME only (never a text, card digit or amount).
 */
@Processor(QUEUES.PAYMENT_RECONCILE, { concurrency: 1 })
export class PaymentReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentReconcileProcessor.name);

  constructor(
    private readonly reconcile: PaymentReconcileService,
    private readonly notifier: BankFeedNotifier,
    private readonly purge: BankTextPurgeService,
  ) {
    super();
  }

  async process(job: JobLike): Promise<PaymentReconcileJobResult | BankTextPurgeResult> {
    switch (job.name) {
      case PAYMENT_RECONCILE_JOB_NAME:
        return this.reconcileJob(job);
      case BANK_TEXT_PURGE_JOB_NAME:
        return this.purgeJob();
      default:
        // A wrong name never becomes right on a retry: fail at once, no attempts spent.
        throw new UnrecoverableError(`unknown payment-reconcile job "${job.name}"`);
    }
  }

  private async purgeJob(): Promise<BankTextPurgeResult> {
    try {
      const result = await this.purge.run();
      this.logger.log(
        `bank-text-purge purged=${String(result.purged)} batches=${String(result.batches)} ` +
          `more=${String(result.more)}`,
      );
      return result;
    } catch (error) {
      this.logger.warn(`bank-text-purge failed: ${nameOf(error)}`);
      throw error;
    }
  }

  private async reconcileJob(job: JobLike): Promise<PaymentReconcileJobResult> {
    try {
      return await this.runOnce();
    } catch (error) {
      // attemptsMade counts the attempts already finished, so this run is number attemptsMade + 1.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await this.alertFailed(error);
      throw error;
    }
  }

  private async runOnce(): Promise<PaymentReconcileJobResult> {
    const report = await this.reconcile.run(new Date());
    const found = Object.entries(report.mismatches)
      .filter(([, f]) => f.count > 0)
      .map(([code, f]) => `${code}=${String(f.count)}`)
      .join(',');
    const line =
      `payment-reconcile day=${report.day} ok=${String(report.ok)} ` +
      `history=${report.history.state} checked=${String(report.checkedMessages)} ` +
      `openReviews=${String(report.openReviews)} mismatches=${found === '' ? '-' : found}`;
    if (report.ok) this.logger.log(line);
    else this.logger.warn(line);
    return { day: report.day, auditId: report.auditId, ok: report.ok };
  }

  /** Last resort: ids only, no database; its own failure is logged, the job fails anyway. */
  private async alertFailed(cause: unknown): Promise<void> {
    // The day of this run, keyed as run() keys its audit row (not the job's creation time).
    const day = tashkentDayKey(new Date());
    this.logger.error(`payment-reconcile day=${day} failed every attempt: ${nameOf(cause)}`);
    try {
      await this.notifier.alert('reconcileFailed', day);
    } catch (alertError) {
      this.logger.error(
        `payment-reconcile day=${day} owner alert failed too: ${nameOf(alertError)}`,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Pick<Job, 'id' | 'attemptsMade'> | undefined, error: Error): void {
    this.logger.warn(
      `payment-reconcile job=${job?.id ?? '?'} attempt=${String(job?.attemptsMade ?? 0)} failed: ${error.name}`,
    );
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
