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
  alertRef,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
} from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { BankFeedHealth } from '../payments/bank-feed-health';
import {
  WATCHDOG_EVERY_MS,
  lookAtHeartbeat,
  type HeartbeatSightings,
  type WatchdogQueue,
} from './heartbeat-outage';
import { WatchdogRepository } from './watchdog.repository';

/** ARMED: over the threshold, but the top-up gate still lets new requests in (CR #1). */
export type BankfeedState = 'UP' | 'DOWN' | 'ARMED' | 'ALERTED' | 'FAILED';

/** The top-up gate as the watchdog reads it (BankFeedHealth; a fake in the unit test). */
export type TopupGate = Pick<BankFeedHealth, 'isAlive'>;

/**
 * API-side watch of the bankfeed container (D-76 (4)): the workerDown check (WorkerDownWatchdog,
 * D-34 (12)) on `bankfeed:process-heartbeat`, which the bankfeed process (and a WORKER_ROLE=all
 * worker) writes every 10 s with a 30 s TTL in every BANK_FEED_MODE. So this alert means "the
 * container is dead", never "no Telegram session" (that is listenerDown / listenerStopped).
 *
 * Same threshold (WORKER_DOWN_ALERT_AFTER_MS), same 30 s tick, same rules: one `bankfeedDown` per
 * outage (the refId is the last sighting, so every tick, instance and restarted API build the
 * same notify job id), re-armed by the next sighting; sightings in Redis time, untrusted ones
 * replaced (heartbeat-outage.ts). Its own sighting key and its own state: it never shares a tick,
 * a key or a job id with workerDown, so neither alert can hide or repeat the other.
 *
 * The text says new requests are stopped, so it is sent only once that is TRUE: the top-up gate
 * (BankFeedHealth, the same check `POST /payments/intents` makes: `bankfeed:heartbeat` in the
 * API clock against BANK_FEED_HEARTBEAT_MAX_AGE_SEC) must say "not alive". Over the threshold
 * with the gate still open (the listener's last round is younger than its max age), the outage
 * stays ARMED and the next tick asks again; the refId (the last sighting) does not move, so the
 * alert that follows is the same single job. A gate read that throws counts as closed: the gate
 * itself fails closed. BankFeedHealth is registered here as our own provider (it needs only the
 * global Redis, config and clock), so notifications never imports PaymentsModule.
 *
 * Off with TELEGRAM_BOT_MODE=off, like NotifyWorker: nothing could be sent. A failed check (Redis
 * down) is FAILED, logged once per streak, never an alert and never stops the API.
 */
@Injectable()
export class BankfeedDownWatchdog implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('BankfeedWatchdog');
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<BankfeedState> | undefined;
  private last: BankfeedState | undefined;
  // The outage being held ARMED (its last sighting), since when (Redis ms), and whether that was
  // already logged as too long.
  private held: { since: number; from: number; logged: boolean } | undefined;

  constructor(
    private readonly repo: WatchdogRepository,
    @InjectQueue(QUEUES.NOTIFY) private readonly queue: WatchdogQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BankFeedHealth) private readonly gate: TopupGate,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_BOT_MODE === 'off') return;
    this.timer = setInterval(() => void this.tick(), WATCHDOG_EVERY_MS);
    // A watchdog never keeps the process alive on its own.
    this.timer.unref();
  }

  beforeApplicationShutdown(): Promise<BankfeedState | undefined> {
    clearInterval(this.timer);
    this.timer = undefined;
    return this.inFlight ?? Promise.resolve(undefined);
  }

  /** One look. Never rejects; a slow Redis skips ticks instead of piling them up. */
  tick(): Promise<BankfeedState> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.check()
      .catch((error: unknown) => this.failed(error))
      .then((state) => {
        this.transition(state);
        return state;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async check(): Promise<BankfeedState> {
    const now = await this.repo.redisNowMs();
    const look = await lookAtHeartbeat(this.sightings, now, this.config.WORKER_DOWN_ALERT_AFTER_MS);
    if (look.state !== 'OVER') return look.state;
    if (await this.gateOpen()) {
      this.noteHeld(look.since, now);
      return 'ARMED';
    }
    const job = notifyJobSchema.parse({
      kind: 'OWNER_ALERT',
      alert: 'bankfeedDown',
      refId: alertRef.bankfeedDown(new Date(look.since)),
    });
    await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
    return 'ALERTED';
  }

  private readonly sightings: HeartbeatSightings = {
    present: () => this.repo.bankfeedHeartbeatPresent(),
    lastSeen: () => this.repo.bankfeedLastSeen(),
    storeLastSeen: (ms) => this.repo.storeBankfeedLastSeen(ms),
    storeLastSeenIfAbsent: (ms) => this.repo.storeBankfeedLastSeenIfAbsent(ms),
  };

  // isAlive never rejects today (it maps every failure to false); a rejection is closed as well.
  private gateOpen(): Promise<boolean> {
    return this.gate.isAlive().catch(() => false);
  }

  /**
   * The gate closes at most BANK_FEED_HEARTBEAT_MAX_AGE_SEC after the listener's last round, and
   * the listener lives in the dead process. Held longer than that, something without a process
   * heartbeat still writes `bankfeed:heartbeat` (an old image, a stray worker): one error per
   * outage (`since`), state and minutes only.
   */
  private noteHeld(since: number, now: number): void {
    if (this.held?.since !== since) this.held = { since, from: now, logged: false };
    if (this.held.logged) return;
    const heldMs = now - this.held.from;
    if (heldMs <= this.config.BANK_FEED_HEARTBEAT_MAX_AGE_SEC * 1000) return;
    this.held.logged = true;
    this.logger.error(
      `bankfeed down but the top-up gate is still open after ${String(Math.floor(heldMs / 60_000))} min: ` +
        'the listener heartbeat is written without a bankfeed process heartbeat',
    );
  }

  private failed(error: unknown): 'FAILED' {
    if (this.last !== 'FAILED') {
      this.logger.warn(`bankfeed check failed: ${describeErrorForLog(error, 200)}`);
    }
    return 'FAILED';
  }

  // Transitions only, never every tick of an outage; no ids, no times.
  private transition(now: BankfeedState): void {
    const before = this.last;
    this.last = now;
    if (now === before) return;
    if (now === 'DOWN' && before !== 'ALERTED') this.logger.warn('bankfeed heartbeat missing');
    if (now === 'ARMED' && before !== 'ALERTED')
      this.logger.warn('bankfeed down: alert held until the top-up gate closes');
    if (now === 'ALERTED') this.logger.error('bankfeed down: owner alert queued');
    if (now === 'UP' && before !== undefined) this.logger.log('bankfeed heartbeat back');
  }
}
