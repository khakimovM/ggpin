import { Logger } from '@nestjs/common';
import { alertRef, type BankFeedAlertKind } from '@repo/shared';
import type { BankFeedNotifier } from '../bank-feed-notifier';
import { withTimeout } from './listener-timeouts';
import { errorCode } from './mtcute-types';

/** Remembered sent alerts before the oldest are forgotten (BullMQ's job id dedupes anyway). */
const SENT_MEMORY = 200;

/**
 * The listener's owner alerts (D-52, review M5): one that could not be queued (Redis away) is
 * kept and tried again on every lock tick, so a stop is never told only to the log. An alert
 * already queued is not queued again by this process (the job id would drop it anyway).
 *
 * Each send is bounded by `timeoutMs` (D-52 r2, review m1/m4): the BullMQ connection has
 * `maxRetriesPerRequest: null`, so without Redis `queue.add` never rejects, it waits. Unbounded,
 * that wait would hold up the caller; bounded, the alert is simply kept for the next tick. The
 * listener stays fail-closed meanwhile (no heartbeat without Redis, the lease runs out).
 */
export class ListenerAlerts {
  private readonly logger = new Logger('BankFeedListener');
  private readonly pending = new Map<string, readonly [BankFeedAlertKind, string]>();
  private readonly sent = new Set<string>();

  constructor(
    private readonly notifier: Pick<BankFeedNotifier, 'alert'>,
    private readonly timeoutMs: number,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  async send(alert: BankFeedAlertKind, refId: string): Promise<void> {
    const key = `${alert}/${refId}`;
    if (this.sent.has(key)) return;
    try {
      await withTimeout(this.notifier.alert(alert, refId), this.timeoutMs, 'alert');
    } catch (error) {
      this.pending.set(key, [alert, refId]);
      this.logger.error(`bank-feed ${alert} alert not queued (retried): ${errorCode(error)}`);
      return;
    }
    this.pending.delete(key);
    this.sent.add(key);
    if (this.sent.size > SENT_MEMORY) {
      const oldest = this.sent.values().next();
      if (oldest.done !== true) this.sent.delete(oldest.value);
    }
  }

  /** Tries the alerts that failed before (each tick). */
  async flush(): Promise<void> {
    for (const [alert, refId] of [...this.pending.values()]) await this.send(alert, refId);
  }
}

/**
 * The worker's own watchdog (D-52, review I3): in live mode, no healthy round for `windowMs`
 * (standby with nobody leading, a start that keeps failing, polls that keep failing, a source
 * that reads BLIND) raises `listenerDown`, once an hour while it lasts. It runs on its OWN timer
 * (D-52 r2, review m1): a hung call in the lock tick can no longer silence it. The refId carries
 * the outage start (the last healthy round, or the process start), so the text says how long
 * without a heartbeat. A listener stopped for good has already sent `listenerStopped` and is not
 * watched. A dead worker process cannot alert at all: the API-side check of the heartbeat is
 * planned for S11.
 */
export class ListenerWatchdog {
  private lastHealthy: Date;

  constructor(
    private readonly windowMs: number | null,
    startedAt: Date,
    private readonly alerts: Pick<ListenerAlerts, 'send'>,
  ) {
    this.lastHealthy = startedAt;
  }

  get enabled(): boolean {
    return this.windowMs !== null;
  }

  healthy(at: Date): void {
    this.lastHealthy = at;
  }

  async check(now: Date): Promise<void> {
    if (this.windowMs === null) return;
    if (now.getTime() - this.lastHealthy.getTime() < this.windowMs) return;
    await this.alerts.send('listenerDown', alertRef.listenerDown(this.lastHealthy, now));
  }
}
