import { Inject, Injectable, Logger } from '@nestjs/common';
import { BANK_FEED_HEARTBEAT_KEY, scrubSecretsInText } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { RedisService } from '../../infra/redis/redis.service';
import { withinMs } from './within-ms';

const READ_TIMEOUT_MS = 500;
const EPOCH_MS = /^\d{1,15}$/;

/**
 * Whether the worker's bank-feed listener is alive (docs/05 §4). The worker writes
 * `bankfeed:heartbeat` = epoch ms on every successful poll. A request handed out while nobody
 * reads the bank bots would be paid and never credited, so anything doubtful means "down":
 * no key, an unreadable value, a value too old, one from the future beyond the allowed age,
 * or Redis not answering (fail closed, 503 PAYMENT_METHOD_UNAVAILABLE).
 */
@Injectable()
export class BankFeedHealth {
  private readonly logger = new Logger(BankFeedHealth.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isAlive(): Promise<boolean> {
    let raw: string | null;
    try {
      raw = await this.readWithTimeout();
    } catch (error) {
      const reason =
        error instanceof Error ? scrubSecretsInText(error.message).slice(0, 200) : 'unknown error';
      this.logger.warn(`bank-feed heartbeat unreadable: ${reason}`);
      return false;
    }
    return isHeartbeatFresh(raw, this.clock.now(), this.config.BANK_FEED_HEARTBEAT_MAX_AGE_SEC);
  }

  private readWithTimeout(): Promise<string | null> {
    return withinMs(this.redis.client.get(BANK_FEED_HEARTBEAT_KEY), READ_TIMEOUT_MS, 'redis');
  }
}

/** Pure part of the check: `raw` is the stored epoch-ms string. */
export function isHeartbeatFresh(raw: string | null, now: Date, maxAgeSec: number): boolean {
  if (raw === null || !EPOCH_MS.test(raw)) return false;
  const ageMs = now.getTime() - Number(raw);
  // A heartbeat from the future (clock skew between hosts) is accepted only within the same bound.
  return Math.abs(ageMs) <= maxAgeSec * 1000;
}
