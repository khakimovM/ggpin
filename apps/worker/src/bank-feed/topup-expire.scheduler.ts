import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { upsertBootSchedule, type SchedulerQueue } from '../infra/queue/boot-scheduler';

export const TOPUP_EXPIRE_JOB_NAME = 'sweep';
export const TOPUP_EXPIRE_SCHEDULE = {
  id: `${QUEUES.TOPUP_EXPIRE}:sweep`,
  rule: { every: 60_000 },
  jobName: TOPUP_EXPIRE_JOB_NAME,
} as const;

/** Registers the every-minute `topup-expire` sweep at boot (in the background, never blocking). */
@Injectable()
export class TopupExpireScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(TopupExpireScheduler.name);
  private scheduled: Promise<void> = Promise.resolve();

  constructor(@InjectQueue(QUEUES.TOPUP_EXPIRE) private readonly queue: SchedulerQueue) {}

  onApplicationBootstrap(): void {
    this.scheduled = upsertBootSchedule(this.queue, this.logger, TOPUP_EXPIRE_SCHEDULE);
  }

  /** Settles when boot scheduling has finished or failed (never rejects); for tests. */
  whenScheduled(): Promise<void> {
    return this.scheduled;
  }
}
