import { Injectable } from '@nestjs/common';
import { walletCacheKey } from '@repo/shared';
import { RedisService } from '../infra/redis/redis.service';

/**
 * Deletes `wallet:{userId}` right AFTER a TOPUP commit (rules/40: invalidated in the code path
 * that wrote the entry). Unlike the API's best-effort cache, a failure here propagates: the
 * bank-message job retries and the replayed effects delete the key again (idempotent), instead
 * of leaving a stale balance on screen until the TTL. Neither key nor balance is ever logged.
 */
@Injectable()
export class WalletCacheInvalidator {
  constructor(private readonly redis: RedisService) {}

  async invalidate(userId: string): Promise<void> {
    await this.redis.client.del(walletCacheKey(userId));
  }
}
