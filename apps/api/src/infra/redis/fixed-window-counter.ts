import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

export interface WindowHit {
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** Seconds until the window ends: 1..windowSec. */
  readonly ttlSec: number;
}

// One script = one atomic step. INCR creates the key without a TTL, so the script gives it one
// whenever it has none (TTL -1): that covers the first hit and also heals a key that somehow
// lost its expiry, which would otherwise block an account for good.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

/**
 * Fixed-window hit counter in Redis: the first hit of a window starts it, later hits count up
 * until the key expires.
 *
 * Callers decide what a count means; they also decide what to do when Redis is down (the
 * returned promise rejects).
 */
@Injectable()
export class FixedWindowCounter {
  constructor(private readonly redis: RedisService) {}

  /** Registers one hit and returns the window's count and its remaining lifetime. */
  async hit(key: string, windowSec: number): Promise<WindowHit> {
    const result: unknown = await this.redis.client.eval(HIT_SCRIPT, 1, key, windowSec);
    const [count, ttl] = Array.isArray(result) ? (result as unknown[]) : [];
    if (typeof count !== 'number' || typeof ttl !== 'number') {
      throw new Error('redis hit script returned an unexpected result');
    }
    // Never longer than the window: after a VM or NTP clock jump Redis may report a TTL above it
    // (seen as Retry-After 602 for a 600 s window under load), and a Retry-After longer than the
    // window it describes would be a lie to the client.
    return { count, ttlSec: Math.min(windowSec, Math.max(1, ttl)) };
  }
}
