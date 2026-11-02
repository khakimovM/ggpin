import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES } from '@repo/shared';
import type { QueueOptions } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { FulfillOrderEnqueuer } from './fulfill-order-enqueuer';
import { BullWorkersShutdown } from './bull-workers-shutdown';
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

// This module only produces jobs; it registers no processors. Inject a queue with
// `@InjectQueue(QUEUES.FULFILL_ORDER)`, but enqueue fulfill-order only through
// FulfillOrderEnqueuer. The tg-outbox consumer lives in NotificationsModule (TgOutboxWorker,
// its own Worker connection with the offline queue enabled); the payment-reconcile consumer
// arrives with phase 4 (docs/02-ARCHITECTURE.md).
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => apiBullOptions(config),
    }),
    queues,
    DiscoveryModule,
  ],
  providers: [BullWorkersShutdown, QueueErrorLogger, FulfillOrderEnqueuer],
  exports: [queues, FulfillOrderEnqueuer],
})
export class QueueModule {}
