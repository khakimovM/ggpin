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

/** Registers the daily `payment-reconcile` run at boot (in the background, never blocking). */
@Injectable()
export class PaymentReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentReconcileScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(@InjectQueue(QUEUES.PAYMENT_RECONCILE) private readonly queue: SchedulerQueue) {}

  onApplicationBootstrap(): void {
    this.scheduled = upsertBootSchedule(this.queue, this.logger, PAYMENT_RECONCILE_SCHEDULE);
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }
}
