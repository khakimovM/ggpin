import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { TgOutboxConsumer } from './tg-outbox.consumer';

/** Queue the worker listens on. Bound to QUEUES.TG_OUTBOX; e2e binds a private queue name. */
export const TG_OUTBOX_QUEUE_NAME = Symbol('TG_OUTBOX_QUEUE_NAME');

// Telegram allows about 30 msg/s overall; stay below it. Per-chat 1 msg/s is the consumer's gate.
export const TG_OUTBOX_LIMITER = { max: 25, duration: 1_000 } as const;
export const TG_OUTBOX_CONCURRENCY = 5;

/**
 * Owns the BullMQ Worker for the outbox instead of using @Processor.
 *
 * Why not @Processor: @nestjs/bullmq's explorer builds the Worker from the registered queue's
 * options, so it would inherit the producer-only `enableOfflineQueue:false` of QueueModule.
 * BullMQ's production guide says to disable the offline queue on Queues only and leave it on
 * for Workers. A dedicated connection `{ url, maxRetriesPerRequest: null }` also lets e2e use a
 * private queue name, so tests never consume jobs of the shared `tg-outbox` queue.
 *
 * Shutdown: `beforeApplicationShutdown` runs before every `onApplicationShutdown`, where
 * PrismaService disconnects, so an in-flight job finishes (Worker.close waits for it) while
 * the database is still up.
 *
 * Off when TELEGRAM_BOT_MODE=off (tests, CI): an app that boots without a real bot must never
 * send, and must not open a blocking Redis connection.
 */
@Injectable()
export class TgOutboxWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('TgOutbox');
  private instance: Worker | undefined;
  private lastError: string | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TG_OUTBOX_QUEUE_NAME) private readonly queueName: string,
    private readonly consumer: TgOutboxConsumer,
  ) {}

  /** The running worker, if any (tests inspect its connection options). */
  get worker(): Worker | undefined {
    return this.instance;
  }

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_BOT_MODE === 'off') return;
    const worker = new Worker(this.queueName, (job, token) => this.consumer.handle(job, token), {
      connection: { url: this.config.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: TG_OUTBOX_CONCURRENCY,
      limiter: TG_OUTBOX_LIMITER,
    });
    // Without a listener ioredis prints every reconnect failure; log each reason once.
    worker.on('error', (error: Error) => {
      if (error.message === this.lastError) return;
      this.lastError = error.message;
      this.logger.warn(`worker error: ${error.message}`);
    });
    worker.on('ready', () => {
      this.lastError = undefined;
    });
    this.instance = worker;
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.instance?.close();
  }
}
