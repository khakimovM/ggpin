import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES } from '@repo/shared';
import type { QueueOptions } from 'bullmq';
import { WORKER_CONFIG, type WorkerConfig } from '../../config/config.module';
import { QueueErrorLogger } from './queue-error-logger';

// BullMQ Workers use blocking commands and refuse a connection whose maxRetriesPerRequest is
// not null. BullMQ owns these connections (opened from the URL, closed with each queue on
// shutdown); the URL is passed through, never logged.
export function workerBullOptions(config: WorkerConfig): QueueOptions {
  return { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null } };
}

const queues = BullModule.registerQueue(
  ...QUEUE_NAMES.map((name) => ({ name, defaultJobOptions: QUEUE_JOB_DEFAULTS[name] })),
);

// Registers every queue from @repo/shared so jobs can be added (cron schedules, follow-ups).
// Processors arrive with their phases: validate-recipient and price-sync in phase 3,
// fulfill-order and fragment-keepalive in phase 5.
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => workerBullOptions(config),
    }),
    queues,
  ],
  providers: [QueueErrorLogger],
  exports: [queues],
})
export class QueueModule {}
