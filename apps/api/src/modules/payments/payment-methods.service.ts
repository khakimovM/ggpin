import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CARD_BANKS,
  PaymentMethodsResponseSchema,
  TOPUP_PROVIDER,
  type PaymentMethodsResponse,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { RedisService } from '../../infra/redis/redis.service';
import { BankFeedHealth } from './bank-feed-health';
import { CardPoolService } from './card-pool.service';
import { withinMs } from './within-ms';

/** One answer for everybody (no user data), so one key. */
export const PAYMENT_METHODS_CACHE_KEY = 'payments:methods';
export const PAYMENT_METHODS_CACHE_SEC = 5;
const REDIS_TIMEOUT_MS = 500;

/**
 * `GET /payments/methods` (docs/04). Every client polls it and the answer needs the card
 * totals (two aggregates), so it is cached for 5 s in Redis (S4-06). The cache only ever saves
 * work: a Redis error, a timeout or an unreadable value is a miss, never an error, and a failed
 * write is ignored. A stale answer lives at most 5 s; `POST /payments/intents` re-checks
 * everything itself, so a cached "available" never hands out a card that has no room.
 */
@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly bankFeed: BankFeedHealth,
    private readonly cards: CardPoolService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async methods(): Promise<PaymentMethodsResponse> {
    const cached = await this.cached();
    if (cached !== null) return cached;
    const fresh = await this.compute();
    await this.store(fresh);
    return fresh;
  }

  private async compute(): Promise<PaymentMethodsResponse> {
    const alive = await this.bankFeed.isAlive();
    const byBank = alive ? await this.cards.availability(this.clock.now()) : null;
    const banks = CARD_BANKS.map((bank) => ({ bank, available: byBank?.[bank] ?? false }));
    return [
      {
        code: TOPUP_PROVIDER,
        available: banks.some((entry) => entry.available),
        banks,
        minTiyin: this.config.TOPUP_MIN_TIYIN.toString(),
        maxTiyin: this.config.TOPUP_MAX_TIYIN.toString(),
        stepTiyin: this.config.TOPUP_STEP_TIYIN.toString(),
      },
    ];
  }

  private async cached(): Promise<PaymentMethodsResponse | null> {
    try {
      const raw = await withinMs(
        this.redis.client.get(PAYMENT_METHODS_CACHE_KEY),
        REDIS_TIMEOUT_MS,
        'redis',
      );
      if (raw === null) return null;
      const parsed = PaymentMethodsResponseSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.miss('read', error);
      return null;
    }
  }

  private async store(value: PaymentMethodsResponse): Promise<void> {
    try {
      await withinMs(
        this.redis.client.set(
          PAYMENT_METHODS_CACHE_KEY,
          JSON.stringify(value),
          'EX',
          PAYMENT_METHODS_CACHE_SEC,
        ),
        REDIS_TIMEOUT_MS,
        'redis',
      );
    } catch (error) {
      this.miss('write', error);
    }
  }

  private miss(op: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : 'unknown error';
    this.logger.warn(`payment methods cache ${op} skipped: ${reason}`);
  }
}
