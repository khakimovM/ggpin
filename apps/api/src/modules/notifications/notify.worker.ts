import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { scrubSecretsInText } from '@repo/shared';
import { Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { NotifyConsumer } from './notify.consumer';

/** Queue the consumer listens on. Bound to QUEUES.NOTIFY; e2e binds a private queue name. */
export const NOTIFY_QUEUE_NAME = Symbol('NOTIFY_QUEUE_NAME');

export const NOTIFY_CONCURRENCY = 5;

/**
 * Owns the BullMQ Worker of `notify`, for the same reasons as TgOutboxWorker (its own blocking
 * connection with the offline queue on, a private queue name in e2e, drained in
 * beforeApplicationShutdown while Prisma is still up). Off when TELEGRAM_BOT_MODE=off: without
 * a bot nothing could be sent, and the jobs wait in Redis for a process that has one.
 */
@Injectable()
export class NotifyWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Notify');
  private instance: Worker | undefined;
  private lastError: string | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFY_QUEUE_NAME) private readonly queueName: string,
    private readonly consumer: NotifyConsumer,
  ) {}

  get worker(): Worker | undefined {
    return this.instance;
  }

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_BOT_MODE === 'off') return;
    const worker = new Worker(this.queueName, (job) => this.consumer.handle(job), {
      connection: { url: this.config.REDIS_URL, maxRetriesPerRequest: null },
      concurrency: NOTIFY_CONCURRENCY,
    });
    worker.on('error', (error: Error) => {
      // ioredis messages can quote the connection URL (password), so scrub before logging.
      const message = scrubSecretsInText(error.message);
      if (message === this.lastError) return;
      this.lastError = message;
      this.logger.warn(`worker error: ${message}`);
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
