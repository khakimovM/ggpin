import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { RedisService } from '../infra/redis/redis.service';

export const HEARTBEAT_INTERVAL_MS = 10_000;
// 3x the interval: two missed beats (a GC pause, a Redis blip) do not flip readiness, a dead
// worker disappears within 30 s.
export const HEARTBEAT_TTL_MS = 30_000;
const SHUTDOWN_CLEAR_TIMEOUT_MS = 1_000;

// Deletes the key only while it still holds our value, so a stopping worker never removes a
// newer worker's beat.
const DELETE_IF_OURS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/**
 * Writes `worker:heartbeat` (ISO time + pid) with a TTL; the API readiness probe reports the
 * worker as up while the key exists. The interval timer is intentionally ref'd: together with
 * the BullMQ connections it is what keeps the worker process alive.
 */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastValue: string | undefined;
  private failing = false;

  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
  }

  // Never rejects. A slow Redis must not pile up writes, so a tick is skipped while the
  // previous write is still pending.
  beat(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.write().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    // Clearing the key flips readiness to degraded at once instead of after the TTL.
    const value = this.lastValue;
    if (value !== undefined) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.redis.client.eval(DELETE_IF_OURS, 1, WORKER_HEARTBEAT_KEY, value),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('timeout')), SHUTDOWN_CLEAR_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Redis unreachable: the TTL expires the key anyway.
      } finally {
        clearTimeout(timeout);
      }
    }
    this.logger.log('heartbeat stopped');
  }

  private async write(): Promise<void> {
    const value = JSON.stringify({ at: new Date().toISOString(), pid: process.pid });
    try {
      await this.redis.client.set(WORKER_HEARTBEAT_KEY, value, 'PX', HEARTBEAT_TTL_MS);
      this.lastValue = value;
      if (this.failing) this.logger.log('heartbeat restored');
      this.failing = false;
    } catch (error) {
      // Log the transition, not every tick of an outage.
      if (!this.failing) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`heartbeat write failed: ${reason}`);
      }
      this.failing = true;
    }
  }
}
