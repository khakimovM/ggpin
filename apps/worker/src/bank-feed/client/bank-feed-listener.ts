import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { alertRef, type BankFeedSource } from '@repo/shared';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import type { AuthorizationsWatch } from './authorizations-watch';
import type { BankChatAnomalyGuard } from './bank-chat-anomaly';
import type { BankFeedAccountRepository } from './bank-feed-account.repository';
import type { BankFeedListenerClient } from './bank-feed-client';
import type { BankFeedPoller } from './bank-feed-poller';
import type { BankFeedBeat } from './heartbeat';
import type { LeaderLock } from './leader-lock';
import { ListenerAlerts, ListenerWatchdog } from './listener-alerts';
import { ListenerRound } from './listener-round';
import { startAndCheckAccount } from './listener-start';
import { ListenerTimers } from './listener-timers';
import { LISTENER_TIMEOUTS, withTimeout, type ListenerTimeouts } from './listener-timeouts';
import { ListenerUpdates } from './listener-updates';
import type { ListenerRepository } from './listener.repository';
import { fatalCodeOf } from './mtcute-bank-feed.client';
import { errorCode } from './mtcute-types';

export interface ListenerTiming {
  /** BANK_FEED_POLL_SEC in ms. */
  readonly pollMs: number;
  /** How often the leader lock is renewed (or a standby tries to take it), the lease checked and the watchdog run. */
  readonly lockMs: number;
  /** No healthy round this long raises `listenerDown` (live mode); null: no watchdog. */
  readonly watchdogMs: number | null;
  /** Bounds of the calls that must not hold up the timers (defaults: LISTENER_TIMEOUTS). */
  readonly timeouts?: ListenerTimeouts;
}

export interface ListenerDeps {
  readonly client: BankFeedListenerClient;
  readonly poller: Pick<BankFeedPoller, 'poll'>;
  readonly lock: Pick<LeaderLock, 'hold' | 'release' | 'isFresh'>;
  readonly beat: BankFeedBeat;
  readonly authorizations: Pick<AuthorizationsWatch, 'check'>;
  readonly account: Pick<BankFeedAccountRepository, 'check'>;
  readonly messages: Pick<ListenerRepository, 'storedMessage'>;
  readonly anomaly: Pick<BankChatAnomalyGuard, 'raise'>;
  readonly pinnedBot: (source: BankFeedSource) => bigint | null;
  readonly notifier: Pick<BankFeedNotifier, 'alert'>;
  readonly timing: ListenerTiming;
  readonly now?: () => Date;
}

export type ListenerState = 'standby' | 'starting' | 'leading' | 'stopped';

/**
 * The bank-feed listener (docs/05 §4, plan S7, D-52). Only the Redis leader lock holder connects.
 * The lock tick renews or takes the lock FIRST, then retries unsent alerts and edit anomalies; the
 * connect runs beside it. The account is checked right after getMe (r2 I-4): MISMATCH and
 * UNBOUND_HISTORY stop for good (r2 L-B), a first binding alerts `accountBound`. Leading needs a
 * fresh local lease, checked every lock interval, before every round and every history page.
 * Start: listener-start.ts; rounds: listener-round.ts; updates: listener-updates.ts (nudge reads
 * need a fresh authorization check, r2 L-A; edits and their retries only the lead, r3 I-A). The watchdog has its own timer and every call that could hang a timer is bounded (r2
 * m1). A fatal error disconnects, clears the heartbeat, releases the lock and sends
 * `listenerStopped` (retried until queued). Logs: states, sources, error codes; never text or IP.
 */
export class BankFeedListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BankFeedListener.name);
  private readonly now: () => Date;
  private readonly timeouts: ListenerTimeouts;
  private readonly alerts: ListenerAlerts;
  private readonly watchdog: ListenerWatchdog;
  private readonly round: ListenerRound;
  private readonly updates: ListenerUpdates;
  private stateValue: ListenerState = 'standby';
  private readonly timers = new ListenerTimers();
  private shutDown = false;
  private ticking: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private readonly guard = (): boolean => this.isLeading();

  constructor(private readonly deps: ListenerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeouts = deps.timing.timeouts ?? LISTENER_TIMEOUTS;
    this.alerts = new ListenerAlerts(deps.notifier, this.timeouts.alertMs);
    this.watchdog = new ListenerWatchdog(deps.timing.watchdogMs, this.now(), this.alerts);
    const fatal = (error: unknown) => this.fatal(error);
    this.round = new ListenerRound({
      ...deps,
      watchdog: this.watchdog,
      guard: this.guard,
      fatal,
      now: this.now,
      pollMs: deps.timing.pollMs,
    });
    this.updates = new ListenerUpdates({
      ...deps,
      alerts: this.alerts,
      mayRead: () => this.mayRead(),
      leading: this.guard,
      fatal: (error) => this.background(this.fatal(error), 'stop'),
      now: this.now,
    });
    deps.client.onNewMessage((nudge) => this.updates.nudge(nudge));
    deps.client.onEditMessage((nudge) => this.updates.edit(nudge));
    deps.client.onFatal((error) => this.background(this.fatal(error), 'stop'));
  }

  get state(): ListenerState {
    return this.stateValue;
  }

  /** The state now: other tasks change it across every await (no TS narrowing). */
  private current(): ListenerState {
    return this.stateValue;
  }

  /** Connected as the leader with a fresh lease: the only state that may read Telegram. */
  isLeading(): boolean {
    return this.stateValue === 'leading' && this.deps.lock.isFresh();
  }

  /** Leading AND the authorizations were checked at most 2 poll intervals ago (r2 L-A). */
  mayRead(): boolean {
    return this.isLeading() && this.round.authorizationsFresh();
  }

  onApplicationBootstrap(): void {
    this.background(this.tick(), 'lock tick');
    const { lockMs, pollMs } = this.deps.timing;
    this.timers.every('lock', lockMs, () => {
      this.checkLease();
      this.background(this.tick(), 'lock tick');
    });
    this.timers.every('poll', pollMs, () => this.background(this.pollRound(), 'poll round'));
    if (this.watchdog.enabled) {
      this.timers.every('watch', lockMs, () => this.background(this.watch(), 'watchdog'));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shutDown = true;
    this.timers.clear();
    const was = this.stateValue;
    this.stateValue = 'stopped';
    if (was === 'leading' || was === 'starting') await this.disconnect();
    // A start still running sees 'stopped' and disconnects itself; it is not awaited (it may hang).
    await this.ticking?.catch(() => undefined);
    await this.polling?.catch(() => undefined);
    await this.deps.client.close();
  }

  /** Renews (or takes) the leader lock FIRST; never waits for a connect. Then retries. */
  tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    this.ticking = this.lockStep().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** One round: authorizations, then both sources; the heartbeat only when all is well. */
  pollRound(): Promise<void> {
    if (this.stateValue !== 'leading') return Promise.resolve();
    if (this.polling !== null) return this.polling;
    this.polling = this.round.run().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** The watchdog check (its own timer in production; tests call it directly). */
  async watch(): Promise<void> {
    if (this.current() !== 'stopped') await this.watchdog.check(this.now());
  }

  /** Test seam: resolves when a running start and round are done. */
  async settled(): Promise<void> {
    await this.starting;
    await this.polling;
  }

  private async lockStep(): Promise<void> {
    if (this.stateValue !== 'stopped') {
      const held = await this.holdLock();
      const state = this.stateValue;
      if ((state === 'leading' || state === 'starting') && !held) {
        this.logger.warn('bank-feed leader lock lost: disconnecting');
        await this.standDown();
      } else if (state === 'standby' && held && this.starting === null) {
        this.starting = this.lead().finally(() => {
          this.starting = null;
        });
        this.background(this.starting, 'start');
      }
    }
    await this.alerts.flush();
    await this.updates.retryPending();
  }

  /**
   * A renewal that does not answer within redisMs counts as lost (r3, review CR-7): the tick ends
   * and retries alerts. A late answer can only make LeaderLock fail closed (held false, not fresh).
   */
  private holdLock(): Promise<boolean> {
    const hold = withTimeout(this.deps.lock.hold(), this.timeouts.redisMs, 'lock.hold');
    return hold.catch(() => false);
  }

  /** Every lock interval, even while a renewal hangs: a stale lease disconnects at once. */
  private checkLease(): void {
    const state = this.stateValue;
    if ((state === 'leading' || state === 'starting') && !this.deps.lock.isFresh()) {
      this.logger.warn('bank-feed leader lease expired locally: disconnecting');
      this.background(this.standDown(), 'stand down');
    }
  }

  private async lead(): Promise<void> {
    this.stateValue = 'starting';
    this.round.reset();
    const { bound, failure } = await startAndCheckAccount(
      this.deps.client,
      this.deps.account,
      this.alerts,
      this.now,
    );
    if (failure !== null) {
      if (fatalCodeOf(failure.error) !== null) return this.fatal(failure.error);
      this.logger.warn(`bank-feed client did not start: ${errorCode(failure.error)}`);
      if (this.current() === 'starting') await this.standDown();
      return;
    }
    if (!(await this.stillStarting())) return;
    this.stateValue = 'leading';
    this.logger.log(`bank-feed listener is the leader (account ${bound ? 'bound' : 'match'})`);
    this.background(this.pollRound(), 'poll round');
  }

  /** After the connect: still wanted, and the lock is still ours (re-checked, D-52). */
  private async stillStarting(): Promise<boolean> {
    if (this.current() !== 'starting') {
      // Stopped or stood down while connecting: drop the connection just made.
      await this.stopClient();
      return false;
    }
    if ((await this.holdLock()) && this.deps.lock.isFresh()) return true;
    this.logger.warn('bank-feed leader lock lost while connecting: disconnecting');
    if (this.current() === 'starting') await this.standDown();
    return false;
  }

  private async standDown(): Promise<void> {
    if (this.stateValue === 'stopped') return;
    this.stateValue = 'standby';
    this.round.reset();
    await this.disconnect();
  }

  /** The connection first, then the heartbeat and the lock (D-52: never the other way round). */
  private async disconnect(): Promise<void> {
    await this.stopClient();
    const { redisMs } = this.timeouts;
    await withTimeout(this.deps.beat.clear(), redisMs, 'beat.clear').catch(() => undefined);
    await withTimeout(this.deps.lock.release(), redisMs, 'lock.release').catch(() => undefined);
  }

  private async stopClient(): Promise<void> {
    const stop = withTimeout(this.deps.client.stop(), this.timeouts.stopMs, 'client.stop');
    await stop.catch((error: unknown) => {
      this.logger.warn(`bank-feed client stop failed: ${errorCode(error)}`);
    });
  }

  private async fatal(error: unknown): Promise<void> {
    const code = fatalCodeOf(error) ?? 'REVOKED';
    if (this.shutDown) return;
    const already = this.stateValue === 'stopped';
    this.stateValue = 'stopped';
    if (already) return;
    // Polls and the watchdog go; the lock timer stays only to retry the alert below until queued.
    this.timers.clear('poll', 'watch');
    this.logger.error(`bank-feed listener stopped: ${code}`);
    await this.disconnect();
    await this.alerts.send('listenerStopped', alertRef.listenerStopped(code, this.now()));
  }

  private background(task: Promise<unknown>, what: string): void {
    // Never an unhandled rejection from a timer (D-52, review L-6).
    task.catch((error: unknown) => {
      this.logger.error(`bank-feed ${what} failed: ${errorCode(error)}`);
    });
  }
}
