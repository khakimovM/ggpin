import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { QUEUES, WORKER_HEARTBEAT_KEY } from '@repo/shared';
import type { Queue } from 'bullmq';
import { RedisService } from '../../infra/redis/redis.service';

/** When the API last saw the worker heartbeat (epoch ms, Redis clock). Shared by every API. */
export const WORKER_LAST_SEEN_KEY = 'worker:watchdog:last-seen';
/** The fulfill-order job the queueStuck check follows, and since when (JSON, Redis clock). */
export const QUEUE_WATCH_KEY = 'worker:watchdog:queue-watch';
// Long enough to outlive any outage the owner would still want one alert for.
const WATCH_TTL_MS = 30 * 24 * 60 * 60_000;

// Compare-and-set of the queue watch: written only if it still holds what the caller read, so two
// API instances never overwrite each other's first sighting. ARGV[1] is '' for "absent" or '=' +
// the value (an empty stored value is then still a value to replace); '' as the new value deletes
// it. 1 = written, 0 = someone else changed it first.
const REPLACE_WATCH_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if cur then return 0 end
elseif (not cur) or ('=' .. cur) ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
end
return 1
`;

/** The reads the watchdog makes of fulfill-order (BullMQ's Queue; a fake in the unit test). */
export type FulfillQueueReader = Pick<Queue, 'getJobs' | 'getJob' | 'getJobState'>;

/** A fulfill-order job that waits to be taken by the worker. */
export interface WaitingFulfillJob {
  /** The BullMQ job id (= the order id, FulfillOrderEnqueuer). */
  readonly id: string | undefined;
  /** When the job was added (epoch ms, the producer's clock: BullMQ sets it on `add`). */
  readonly addedAt: number;
  /** How many times a worker has taken it (BullMQ `attemptsStarted`). */
  readonly taken: number;
}

/** Where a fulfill-order job is now (BullMQ state) and how many times it was taken. */
export interface FulfillJobState {
  readonly state: string;
  readonly taken: number;
}

/**
 * The Redis reads and writes of the worker watchdog (review m4), like HealthRepository: the
 * worker heartbeat, the last sighting of it, Redis's own clock, the head of the fulfill-order
 * queue and the job the queue check follows. No rules here; the watchdog decides.
 */
@Injectable()
export class WatchdogRepository {
  constructor(
    private readonly redis: RedisService,
    // Registered globally by QueueModule; read here, never added to (FulfillOrderEnqueuer adds).
    @InjectQueue(QUEUES.FULFILL_ORDER) private readonly fulfillQueue: FulfillQueueReader,
  ) {}

  // The worker writes this key with a TTL (apps/worker/src/heartbeat); present = alive.
  async heartbeatPresent(): Promise<boolean> {
    return (await this.redis.client.exists(WORKER_HEARTBEAT_KEY)) === 1;
  }

  /**
   * Redis's clock (TIME), epoch ms. The last sighting is written and compared in this one clock,
   * so API instances whose clocks disagree cannot push it into each other's future (audit L-1).
   */
  async redisNowMs(): Promise<number> {
    const [seconds, micros] = (await this.redis.client.time()).map(Number);
    if (seconds === undefined || micros === undefined || !Number.isSafeInteger(seconds)) {
      throw new Error('unexpected TIME reply');
    }
    return seconds * 1_000 + Math.floor(micros / 1_000);
  }

  lastSeen(): Promise<string | null> {
    return this.redis.client.get(WORKER_LAST_SEEN_KEY);
  }

  async storeLastSeen(epochMs: number): Promise<void> {
    await this.redis.client.set(WORKER_LAST_SEEN_KEY, String(epochMs), 'PX', WATCH_TTL_MS);
  }

  /** Stores the sighting only if none exists (another instance may have just stored one). */
  async storeLastSeenIfAbsent(epochMs: number): Promise<void> {
    await this.redis.client.set(WORKER_LAST_SEEN_KEY, String(epochMs), 'PX', WATCH_TTL_MS, 'NX');
  }

  /**
   * The waiting fulfill-order job that was added first, or null. `getJobs(types, 0, 0, true)`
   * returns, per state, the job the worker takes next: the tail of the `wait` (and `paused`) list,
   * which is the oldest there (BullMQ LPUSHes new jobs), and the lowest score of `prioritized`
   * (fulfill-order is never prioritized today; checked anyway). Delayed (a retry's backoff) and
   * active jobs are not waiting and are not read.
   */
  async oldestWaitingFulfillJob(): Promise<WaitingFulfillJob | null> {
    const heads = await this.fulfillQueue.getJobs(['wait', 'paused', 'prioritized'], 0, 0, true);
    let oldest: WaitingFulfillJob | null = null;
    for (const job of heads) {
      if (!Number.isSafeInteger(job.timestamp) || job.timestamp <= 0) continue;
      if (oldest === null || job.timestamp < oldest.addedAt) {
        oldest = { id: job.id, addedAt: job.timestamp, taken: takeCount(job.attemptsStarted) };
      }
    }
    return oldest;
  }

  /** The job's state (`waiting` covers a paused queue) and take count; null if it is gone. */
  async fulfillJob(id: string): Promise<FulfillJobState | null> {
    // State first: a job taken between the two reads shows a higher count, never a false wait.
    const state = await this.fulfillQueue.getJobState(id);
    const job = await this.fulfillQueue.getJob(id);
    if (job === undefined || state === 'unknown') return null;
    return { state, taken: takeCount(job.attemptsStarted) };
  }

  queueWatch(): Promise<string | null> {
    return this.redis.client.get(QUEUE_WATCH_KEY);
  }

  /** Writes `next` (null = delete) only if the watch still is `expected`; true when written. */
  async replaceQueueWatch(expected: string | null, next: string | null): Promise<boolean> {
    const result: unknown = await this.redis.client.eval(
      REPLACE_WATCH_SCRIPT,
      1,
      QUEUE_WATCH_KEY,
      expected === null ? '' : `=${expected}`,
      next ?? '',
      WATCH_TTL_MS,
    );
    return result === 1;
  }
}

// BullMQ reads `ats` with parseInt; anything odd counts as never taken rather than a value the
// watchdog would reject on every tick (and so never time).
function takeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
