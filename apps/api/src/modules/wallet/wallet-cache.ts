import { Injectable, Logger } from '@nestjs/common';
import {
  WALLET_CACHE_TTL_SEC,
  decodeCachedBalance,
  encodeCachedBalance,
  scrubSecretsInText,
  walletCacheKey,
} from '@repo/shared';
import { RedisService } from '../../infra/redis/redis.service';

// A read must not wait on a dead Redis: past this the caller goes to Postgres instead. A DEL
// gets longer because skipping it leaves a stale balance on screen until the TTL runs out.
const READ_TIMEOUT_MS = 400;
const DEL_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`redis did not answer within ${String(ms)} ms`));
    }, ms);
  });
  // The loser keeps running; swallow its late rejection so it cannot become unhandled.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * The `wallet:{userId}` balance cache. The balance itself is always SUM(ledger); this only saves
 * the SUM on hot reads. Every method is best effort: Redis being down means "no cache", never an
 * error for the caller, because money correctness does not depend on this layer (a purchase
 * recomputes the SUM under the wallet lock).
 *
 * Residual race, bounded by the TTL: a reader can compute the SUM, a writer can then commit and
 * DEL, and the reader's SET lands after it, caching the older balance for up to
 * WALLET_CACHE_TTL_SEC. Display only; see docs/04 (clients refetch after money events).
 */
@Injectable()
export class WalletCache {
  private readonly logger = new Logger(WalletCache.name);

  constructor(private readonly redis: RedisService) {}

  /** The cached balance, or null on a miss, a corrupt value or any Redis failure. */
  async get(userId: string): Promise<bigint | null> {
    try {
      const raw = await withTimeout(this.redis.client.get(walletCacheKey(userId)), READ_TIMEOUT_MS);
      return decodeCachedBalance(raw);
    } catch (error) {
      this.warn('get', error);
      return null;
    }
  }

  async set(userId: string, balanceTiyin: bigint): Promise<void> {
    try {
      await withTimeout(
        this.redis.client.set(
          walletCacheKey(userId),
          encodeCachedBalance(balanceTiyin),
          'EX',
          WALLET_CACHE_TTL_SEC,
        ),
        READ_TIMEOUT_MS,
      );
    } catch (error) {
      this.warn('set', error);
    }
  }

  /** Call right AFTER the ledger transaction has committed, never inside it. */
  async invalidate(userId: string): Promise<void> {
    try {
      await withTimeout(this.redis.client.del(walletCacheKey(userId)), DEL_TIMEOUT_MS);
    } catch (error) {
      this.warn('del', error);
    }
  }

  // No key and no value in the log: the key holds a user id, the value a balance.
  private warn(op: string, error: unknown): void {
    // ioredis messages can quote the connection URL (password): scrubbed like every Redis error.
    const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
    this.logger.warn(`wallet cache ${op} failed: ${reason}`);
  }
}
