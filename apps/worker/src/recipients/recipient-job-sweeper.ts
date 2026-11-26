import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import type { Queue } from 'bullmq';
import { RedisService } from '../infra/redis/redis.service';
import { RECIPIENT_CHECK_TIMING, type RecipientCheckTiming } from './recipient-check.config';
import { errorNameOf } from './recipient-lookup.service';

/** Jobs removed per state per `clean` call; a full batch is followed by another (bounded). */
export const SWEEP_BATCH = 1_000;
const MAX_BATCHES_PER_STATE = 10;

/**
 * States swept. `completed` / `failed`: BullMQ applies `removeOnComplete/removeOnFail.age` only
 * when ANOTHER job finishes (its moveToFinished script), and a job hash has no Redis TTL, so on a
 * quiet queue the last answer (username, display name, providerRef) would stay until the next
 * check. `wait`: a question nobody took (no worker ran) past the retention is useless (its
 * answer would be too late, the processor would only answer STALE) and holds the input.
 * `prioritized`: the same for a question added with a priority (audit M-1 may make the API do so).
 */
export const SWEPT_STATES = ['completed', 'failed', 'wait', 'prioritized'] as const;

/**
 * Removes `validate-recipient` jobs older than the API's retention (RECIPIENT_CHECK_RETENTION_SEC)
 * every `sweepEveryMs`, once at boot too, and trims the queue's events stream to the same age
 * (audit L-2): its `completed` entries copy the answer (display name, providerRef) and every entry
 * names the job id; the stream's own MAXLEN bounds its length, not its age. With a 30 s period a
 * job hash AND its events are gone at most 60 + 30 s after the job finished. The API's QueueEvents
 * reads at most ~10 s behind, so a 60 s trim never takes an entry it still needs.
 * A plain timer, not a repeatable job: a job on this queue would be the processor's to run,
 * and a scheduler entry would outlive the process. unref'd (never what keeps the worker alive),
 * stopped on shutdown. A failure is a warning with the error's class name only; the next tick
 * tries again. Several replicas sweeping at once is harmless (`clean` is one Lua script).
 */
@Injectable()
export class RecipientJobSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RecipientJobSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private failing = false;

  constructor(
    @InjectQueue(QUEUES.VALIDATE_RECIPIENT) private readonly queue: Queue,
    @Inject(RECIPIENT_CHECK_TIMING) private readonly timing: RecipientCheckTiming,
    // The worker's own ioredis client, same REDIS_URL as BullMQ: the queue's client type
    // (IRedisClient) has no TIME / XTRIM.
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.timing.sweepEveryMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep; never rejects. A tick is skipped while the previous sweep still runs. */
  sweep(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.clean().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async clean(): Promise<void> {
    try {
      for (const state of SWEPT_STATES) {
        for (let batch = 0; batch < MAX_BATCHES_PER_STATE; batch += 1) {
          const removed = await this.queue.clean(this.timing.retentionMs, SWEEP_BATCH, state);
          if (removed.length < SWEEP_BATCH) break;
        }
      }
      await this.trimEvents();
      if (this.failing) this.logger.log('validate-recipient sweep restored');
      this.failing = false;
    } catch (error) {
      // Log the transition, not every tick of an outage. Removed job ids are never logged.
      if (!this.failing) {
        this.logger.warn(`validate-recipient sweep failed: ${errorNameOf(error)}`);
      }
      this.failing = true;
    }
  }

  /**
   * XTRIM MINID, exact (no `~`): entry ids are Redis server milliseconds, so the cut is computed
   * from the server's TIME, never from this process's clock.
   */
  private async trimEvents(): Promise<void> {
    const client = this.redis.client;
    const [seconds, micros] = await client.time();
    const nowMs = Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('redis TIME is not a number');
    const minId = nowMs - this.timing.retentionMs;
    await client.xtrim(this.queue.toKey('events'), 'MINID', String(minId));
  }
}
