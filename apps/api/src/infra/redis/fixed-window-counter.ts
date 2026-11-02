import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Fixed-window hit counter in Redis: the first hit of a window starts it, later hits count up
 * until the key expires. INCR and EXPIRE NX run in one MULTI, so a crash between them cannot
 * leave a key without a TTL (that would block an account for good). Needs Redis 7 (EXPIRE NX).
 *
 * Callers decide what a count means; they also decide what to do when Redis is down (the
 * returned promise rejects).
 */
@Injectable()
export class FixedWindowCounter {
  constructor(private readonly redis: RedisService) {}

  /** Registers one hit and returns how many hits the current window holds, this one included. */
  async hit(key: string, windowSec: number): Promise<number> {
    const results = await this.redis.client.multi().incr(key).expire(key, windowSec, 'NX').exec();
    const [error, count] = results?.[0] ?? [new Error('redis MULTI returned no result'), null];
    if (error !== null) throw error;
    if (typeof count !== 'number') throw new Error('redis INCR returned a non-number');
    return count;
  }
}
