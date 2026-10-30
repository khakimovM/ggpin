import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';

/**
 * The API's own Redis client (readiness probe now; wallet balance cache, rate limits and
 * locks later). BullMQ opens its own connections from the same URL (see queue.module.ts) so
 * a stuck queue connection never blocks these commands.
 *
 * - lazyConnect: building the module graph (unit tests) opens no socket; the first command
 *   connects.
 * - maxRetriesPerRequest 1: a command fails after one reconnect round instead of queueing
 *   forever while Redis is down, so callers see the outage.
 * - The URL may contain a password, so it is never logged; ioredis error messages carry only
 *   host:port and the reason.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);
  private lastError: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    // Without an 'error' listener ioredis prints every reconnect failure; log each distinct
    // reason once instead of once per retry.
    this.client.on('error', (error: Error) => {
      if (error.message === this.lastError) return;
      this.lastError = error.message;
      this.logger.warn(`redis error: ${error.message}`);
    });
    this.client.on('ready', () => {
      if (this.lastError !== undefined) this.logger.log('redis connection restored');
      this.lastError = undefined;
    });
  }

  // onApplicationShutdown runs after every onModuleDestroy and after the HTTP server stops,
  // so no request is still using the client when the connection goes away.
  async onApplicationShutdown(): Promise<void> {
    if (this.client.status !== 'ready') {
      // Never connected (lazy) or reconnecting: QUIT would connect or wait; drop the socket.
      this.client.disconnect();
      return;
    }
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
