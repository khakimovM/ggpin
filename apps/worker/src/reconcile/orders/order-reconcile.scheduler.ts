import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { upsertBootSchedule, type SchedulerQueue } from '../../infra/queue/boot-scheduler';

export const ORDER_RECONCILE_JOB_NAME = 'orders';
export const ORDER_RECONCILE_SCHEDULE_ID = `${QUEUES.RECONCILE}:orders`;

/**
 * Registers the order reconciler's tick (`reconcile:orders`, every ORDER_RECONCILE_EVERY_MS, D-64
 * (1)) at boot, in the background, never blocking. Upserting the same id again replaces the rule,
 * so N boots or N workers leave one scheduler.
 */
@Injectable()
export class OrderReconcileScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderReconcileScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(
    @InjectQueue(QUEUES.RECONCILE) private readonly queue: SchedulerQueue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduled = upsertBootSchedule(this.queue, this.logger, {
      id: ORDER_RECONCILE_SCHEDULE_ID,
      rule: { every: this.config.ORDER_RECONCILE_EVERY_MS },
      jobName: ORDER_RECONCILE_JOB_NAME,
    });
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }
}
