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

  /**
   * Many cached balances in ONE round trip (MGET), for list screens. A miss, a corrupt value or
   * any Redis failure leaves that user out of the map (the caller sums the ledger for it).
   */
  async getMany(userIds: readonly string[]): Promise<Map<string, bigint>> {
    const found = new Map<string, bigint>();
    if (userIds.length === 0) return found;
    try {
      const raws = await withTimeout(
        this.redis.client.mget(...userIds.map(walletCacheKey)),
        READ_TIMEOUT_MS,
      );
      userIds.forEach((id, index) => {
        const value = decodeCachedBalance(raws[index] ?? null);
        if (value !== null) found.set(id, value);
      });
    } catch (error) {
      this.warn('mget', error);
    }
    return found;
  }

  /** Many balances in ONE pipelined round trip, each with the usual TTL. Best effort. */
  async setMany(balances: ReadonlyMap<string, bigint>): Promise<void> {
    if (balances.size === 0) return;
    try {
      const pipeline = this.redis.client.pipeline();
      for (const [userId, balance] of balances) {
        pipeline.set(
          walletCacheKey(userId),
          encodeCachedBalance(balance),
          'EX',
          WALLET_CACHE_TTL_SEC,
        );
      }
      await withTimeout(pipeline.exec(), READ_TIMEOUT_MS);
    } catch (error) {
      this.warn('pipeline set', error);
    }
  }

  // No key and no value in the log: the key holds a user id, the value a balance.
  private warn(op: string, error: unknown): void {
    // ioredis messages can quote the connection URL (password): scrubbed like every Redis error.
    const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
    this.logger.warn(`wallet cache ${op} failed: ${reason}`);
  }
}
