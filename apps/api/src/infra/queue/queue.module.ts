import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES } from '@repo/shared';
import type { QueueOptions } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { QueueErrorLogger } from './queue-error-logger';

// Producer-only connection. enableOfflineQueue=false makes `queue.add` fail fast while Redis
// is disconnected instead of buffering in memory, so the caller (e.g. order creation in
// phase 5) sees the failure and the reconciler can re-enqueue. BullMQ owns these connections
// and closes them with each queue on shutdown; the URL is passed through, never logged.
export function apiBullOptions(config: AppConfig): QueueOptions {
  return { connection: { url: config.REDIS_URL, enableOfflineQueue: false } };
}

const queues = BullModule.registerQueue(
  ...QUEUE_NAMES.map((name) => ({ name, defaultJobOptions: QUEUE_JOB_DEFAULTS[name] })),
);

// The API only produces jobs; it registers no processors. Inject a queue with
// `@InjectQueue(QUEUES.FULFILL_ORDER)`. (tg-outbox and payment-reconcile consumers live in
// the API per docs/02-ARCHITECTURE.md and arrive with phases 2 and 4.)
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => apiBullOptions(config),
    }),
    queues,
  ],
  providers: [QueueErrorLogger],
  exports: [queues],
})
export class QueueModule {}
