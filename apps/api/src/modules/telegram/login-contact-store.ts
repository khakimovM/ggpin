import { Injectable } from '@nestjs/common';
import { LOGIN_NONCE_TTL_SEC } from '@repo/shared';
import { RedisService } from '../../infra/redis/redis.service';
import type { PendingLoginStore } from './bot-deps';

const key = (telegramId: bigint): string => `tg:login-contact:${telegramId.toString()}`;

/**
 * Remembers which login link an account was asked to share its phone for. The nonce is a
 * short-lived login secret, so it lives only in Redis and only as long as the link itself.
 */
@Injectable()
export class LoginContactStore implements PendingLoginStore {
  constructor(private readonly redis: RedisService) {}

  async remember(telegramId: bigint, nonce: string): Promise<void> {
    await this.redis.client.set(key(telegramId), nonce, 'EX', LOGIN_NONCE_TTL_SEC);
  }

  // GETDEL: of two parallel contact messages exactly one gets the nonce.
  take(telegramId: bigint): Promise<string | null> {
    return this.redis.client.getdel(key(telegramId));
  }
}
