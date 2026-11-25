import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { upsertBootSchedule, type SchedulerQueue } from '../../infra/queue/boot-scheduler';

export const FRAGMENT_KEEPALIVE_JOB_NAME = 'check';
/** One fixed scheduler id: N boots or N replicas leave one scheduler (boot-scheduler.ts). */
export const FRAGMENT_KEEPALIVE_SCHEDULER_ID = `${QUEUES.FRAGMENT_KEEPALIVE}:check`;

/** Registers the Fragment keep-alive every FRAGMENT_KEEPALIVE_EVERY_MS (20 min) at boot. */
@Injectable()
export class FragmentKeepaliveScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(FragmentKeepaliveScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(
    @InjectQueue(QUEUES.FRAGMENT_KEEPALIVE) private readonly queue: SchedulerQueue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduled = upsertBootSchedule(this.queue, this.logger, {
      id: FRAGMENT_KEEPALIVE_SCHEDULER_ID,
      rule: { every: this.config.FRAGMENT_KEEPALIVE_EVERY_MS },
      jobName: FRAGMENT_KEEPALIVE_JOB_NAME,
    });
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }
}
