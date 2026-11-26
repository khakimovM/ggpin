import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  QUEUE_STUCK_AFTER_MS,
  alertRef,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
  type NotifyJob,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { WatchdogRepository } from './watchdog.repository';

export const WATCHDOG_EVERY_MS = 30_000;
const EPOCH_MS = /^\d{1,15}$/;
// A fulfill-order job still waiting to be taken (a paused queue reports `waiting` too).
const WAITING_STATES: readonly string[] = ['waiting', 'prioritized'];

// The job the queue check follows: its id, when this check first saw it waiting (Redis clock) and
// how many times it had been taken then. Anything else in the key is replaced (audit P1 pattern).
const QueueWatchSchema = z
  .object({
    id: z.string().min(1).max(128),
    at: z.number().int().positive(),
    taken: z.number().int().nonnegative(),
  })
  .strict();
type QueueWatch = z.infer<typeof QueueWatchSchema>;

export type WorkerState = 'UP' | 'DOWN' | 'ALERTED' | 'FAILED';
export type QueueState = 'OK' | 'STUCK' | 'FAILED';
export interface WatchdogTick {
  readonly worker: WorkerState;
  readonly queue: QueueState;
}

/** The part of the notify queue the watchdog uses (BullMQ's Queue; a fake in the unit test). */
export type WatchdogQueue = Pick<Queue, 'add'>;

/**
 * API-side watch of the worker (D-34 (12), phase 5 S6). Every 30 s, two independent checks:
 *
 * - workerDown: is `worker:heartbeat` there (the worker writes it every 10 s, 30 s TTL)? While it
 *   is, the time is stored in Redis as the last sighting. When it has been gone for
 *   WORKER_DOWN_ALERT_AFTER_MS, the owner hears `workerDown` once: the refId is that sighting, so
 *   every later tick, every other API instance and a restarted API build the SAME notify job id
 *   and BullMQ drops the repeat; a new outage after recovery is a new id. The sighting is written
 *   and compared in Redis's clock (TIME), never the instances' own. A sighting that cannot be
 *   trusted (unreadable, negative, or more than one tick in the future: an edited key or a clock
 *   jump) is replaced by now, so it can never silence the alert (audit L-1). An API that has
 *   never seen a heartbeat counts from its first look (stored only if none exists yet).
 * - queueStuck (review M2, audit M-2, re-review episodes): Redis keeps ONE followed job: the
 *   oldest waiting fulfill-order job, with the Redis time this check first saw it waiting and
 *   its take count. While that same job is still waiting, untaken, for more than
 *   QUEUE_STUCK_AFTER_MS since that first sighting, the owner hears one `queueStuck` (refId = job
 *   id + first sighting, so every tick and instance builds the same notify job id). Once it is
 *   taken (or gone), the next oldest waiting job is followed from now; an empty queue clears the
 *   key. So a busy but working worker (jobs taken one by one) never alerts, however long the
 *   queue, and a retried job back in `wait` starts a new 5 minutes; this catches what the
 *   heartbeat cannot: a worker that beats but takes nothing (a crash loop that beats once per
 *   boot, a hung processor slot). The age is never BullMQ's add time (the producer's clock, and a
 *   retry keeps it). The first sighting is a compare-and-set: two instances never overwrite each
 *   other. Active jobs are deliberately not timed: a TON payout may legitimately stay active for
 *   minutes while its transfer is confirmed (S4/S5). Residual: a job taken by a worker that then
 *   dies comes back from `active` as stalled with a new take count, so it is followed afresh
 *   (no queueStuck for that episode); S4 (stalled -> review) and S9 cover it.
 *
 * Off with TELEGRAM_BOT_MODE=off, like NotifyWorker: nothing could be sent. A failed check (Redis
 * down) is logged once per streak and never stops the API.
 */
@Injectable()
export class WorkerDownWatchdog implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('WorkerWatchdog');
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<WatchdogTick> | undefined;
  private last: Partial<WatchdogTick> = {};

  constructor(
    private readonly repo: WatchdogRepository,
    @InjectQueue(QUEUES.NOTIFY) private readonly queue: WatchdogQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_BOT_MODE === 'off') return;
    this.timer = setInterval(() => void this.tick(), WATCHDOG_EVERY_MS);
    // A watchdog never keeps the process alive on its own.
    this.timer.unref();
  }

  beforeApplicationShutdown(): Promise<WatchdogTick | undefined> {
    clearInterval(this.timer);
    this.timer = undefined;
    return this.inFlight ?? Promise.resolve(undefined);
  }

  /** One look. Never rejects; a slow Redis skips ticks instead of piling them up. */
  tick(): Promise<WatchdogTick> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = Promise.all([
      this.checkWorker().catch((error: unknown) => this.failed('worker', error)),
      this.checkQueue().catch((error: unknown) => this.failed('queue', error)),
    ])
      .then(([worker, queue]) => {
        this.transition({ worker, queue });
        return { worker, queue };
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async checkWorker(): Promise<WorkerState> {
    const now = await this.repo.redisNowMs();
    if (await this.repo.heartbeatPresent()) {
      await this.repo.storeLastSeen(now);
      return 'UP';
    }
    const stored = await this.repo.lastSeen();
    let lastSeen = this.trusted(stored, now);
    if (lastSeen === null) {
      // Never seen: count from now unless another instance just stored one. Untrusted: replace
      // it unconditionally (NX would keep a future value forever, audit P1).
      if (stored === null) await this.repo.storeLastSeenIfAbsent(now);
      else await this.repo.storeLastSeen(now);
      lastSeen = this.trusted(await this.repo.lastSeen(), now) ?? now;
    }
    if (now - lastSeen < this.config.WORKER_DOWN_ALERT_AFTER_MS) return 'DOWN';
    await this.alert({
      kind: 'OWNER_ALERT',
      alert: 'workerDown',
      refId: alertRef.workerDown(new Date(lastSeen)),
    });
    return 'ALERTED';
  }

  private async checkQueue(): Promise<QueueState> {
    const now = await this.repo.redisNowMs();
    const stored = await this.repo.queueWatch();
    const watch = this.trustedWatch(stored, now);
    if (watch !== null && (await this.stillWaiting(watch))) {
      if (now - watch.at <= QUEUE_STUCK_AFTER_MS) return 'OK';
      await this.alert({
        kind: 'OWNER_ALERT',
        alert: 'queueStuck',
        refId: alertRef.queueStuck(watch.id, new Date(watch.at)),
      });
      return 'STUCK';
    }
    // Nothing followed, or it moved on: follow the oldest waiting job from now. A lost race means
    // another instance just did the same; its sighting stands and is read on the next tick.
    const oldest = await this.repo.oldestWaitingFulfillJob();
    const next: QueueWatch | null =
      oldest?.id === undefined ? null : { id: oldest.id, at: now, taken: oldest.taken };
    await this.repo.replaceQueueWatch(stored, next === null ? null : JSON.stringify(next));
    return 'OK';
  }

  // The same job, in a waiting state, and not taken since it was first seen.
  private async stillWaiting(watch: QueueWatch): Promise<boolean> {
    const job = await this.repo.fulfillJob(watch.id);
    return job !== null && WAITING_STATES.includes(job.state) && job.taken === watch.taken;
  }

  /** The followed job, or null for a missing, malformed or future (> one tick) value. */
  private trustedWatch(value: string | null, now: number): QueueWatch | null {
    if (value === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      return null;
    }
    const watch = QueueWatchSchema.safeParse(json);
    if (!watch.success || watch.data.at > now + WATCHDOG_EVERY_MS) return null;
    return watch.data;
  }

  /** A sighting to count from: our own epoch ms, not past `now` by more than one tick. */
  private trusted(value: string | null, now: number): number | null {
    if (value === null || !EPOCH_MS.test(value)) return null;
    const ms = Number(value);
    return ms > now + WATCHDOG_EVERY_MS ? null : ms;
  }

  private async alert(data: NotifyJob): Promise<void> {
    const job = notifyJobSchema.parse(data);
    await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
  }

  private failed(check: keyof WatchdogTick, error: unknown): 'FAILED' {
    if (this.last[check] !== 'FAILED') {
      this.logger.warn(`${check} check failed: ${describeErrorForLog(error, 200)}`);
    }
    return 'FAILED';
  }

  // Transitions only, never every tick of an outage; no ids, no times.
  private transition(now: WatchdogTick): void {
    const before = this.last;
    this.last = now;
    if (now.worker !== before.worker) {
      if (now.worker === 'DOWN' && before.worker !== 'ALERTED') {
        this.logger.warn('worker heartbeat missing');
      }
      if (now.worker === 'ALERTED') this.logger.error('worker down: owner alert queued');
      if (now.worker === 'UP' && before.worker !== undefined)
        this.logger.log('worker heartbeat back');
    }
    if (now.queue !== before.queue) {
      if (now.queue === 'STUCK') this.logger.error('fulfill-order queue stuck: owner alert queued');
      if (now.queue === 'OK' && before.queue === 'STUCK')
        this.logger.log('fulfill-order queue moving');
    }
  }
}
