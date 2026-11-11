import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { upsertBootSchedule, type SchedulerQueue } from '../infra/queue/boot-scheduler';

export const PAYMENT_RECONCILE_JOB_NAME = 'daily';
/** 03:00 in Tashkent every day (UTC+5, no DST: 22:00 UTC), read by BullMQ in that zone. */
export const PAYMENT_RECONCILE_SCHEDULE = {
  id: `${QUEUES.PAYMENT_RECONCILE}:daily`,
  rule: { pattern: '0 3 * * *', tz: 'Asia/Tashkent' },
  jobName: PAYMENT_RECONCILE_JOB_NAME,
} as const;

export const BANK_TEXT_PURGE_JOB_NAME = 'bank-text-purge';
/**
 * 03:30 in Tashkent every day, on the same queue (the processor dispatches on the job name).
 * Half an hour after the reconciliation only to keep the two apart in the logs and in load: the
 * reconciliation never reads raw texts, so their order does not matter for correctness. Within
 * one worker process they never overlap (concurrency 1 is per process); two workers could run
 * them at once, which is harmless (the purge is idempotent, SKIP LOCKED, and touches no row the
 * reconciliation writes).
 */
export const BANK_TEXT_PURGE_SCHEDULE = {
  id: `${QUEUES.PAYMENT_RECONCILE}:${BANK_TEXT_PURGE_JOB_NAME}`,
  rule: { pattern: '30 3 * * *', tz: 'Asia/Tashkent' },
  jobName: BANK_TEXT_PURGE_JOB_NAME,
} as const;

/**
 * Registers the daily `payment-reconcile` run and the raw-text purge at boot (in the background,
 * never blocking).
 */
@Injectable()
export class PaymentReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentReconcileScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(@InjectQueue(QUEUES.PAYMENT_RECONCILE) private readonly queue: SchedulerQueue) {}

  onApplicationBootstrap(): void {
    this.scheduled = this.schedule();
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }

  private async schedule(): Promise<void> {
    for (const schedule of [PAYMENT_RECONCILE_SCHEDULE, BANK_TEXT_PURGE_SCHEDULE]) {
      await upsertBootSchedule(this.queue, this.logger, schedule);
    }
  }
}
