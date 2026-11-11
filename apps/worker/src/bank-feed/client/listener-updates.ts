import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import type { BankChatAnomalyGuard } from './bank-chat-anomaly';
import type { BankFeedNudge } from './bank-feed-client';
import type { BankFeedPoller, PollGuard } from './bank-feed-poller';
import type { ListenerAlerts } from './listener-alerts';
import type { ListenerRepository } from './listener.repository';
import { fatalCodeOf } from './mtcute-bank-feed.client';
import { errorCode } from './mtcute-types';

/** Edit anomalies kept for a retry; more are dropped (all of one hour share one alert anyway). */
const PENDING_MAX = 50;

export interface ListenerUpdatesDeps {
  readonly poller: Pick<BankFeedPoller, 'poll'>;
  readonly messages: Pick<ListenerRepository, 'storedMessage'>;
  readonly anomaly: Pick<BankChatAnomalyGuard, 'raise'>;
  readonly pinnedBot: (source: BankFeedSource) => bigint | null;
  readonly alerts: Pick<ListenerAlerts, 'send'>;
  /**
   * A nudge reads only while the listener leads with a fresh lease AND its last authorization
   * check is fresh (D-52 r2, review L-A): a nudge never reads around a failing check.
   */
  readonly mayRead: PollGuard;
  /**
   * Edits and their pending anomalies need only the lead (r3, audit I-A): they read nothing from
   * Telegram, and a stale authorization check must never silence an OUTGOING edit anomaly.
   */
  readonly leading: PollGuard;
  /** A fatal error found while handling an update stops the listener. */
  readonly fatal: (error: unknown) => void;
  readonly now: () => Date;
}

/**
 * Live updates of the two bot chats (docs/05 §4): only nudges. A new message polls its source
 * early (the poll ingests in id order). An edit of a stored message raises `edited` with the row
 * id, and an edit of the account's OWN stored message (OUTGOING) is also a bank-chat anomaly
 * (D-52, L-1); an anomaly that could not be raised (Redis or a card lock busy) is kept and raised
 * again on every lock tick (D-52 r2, review m5). An edit of a message not stored yet is left to
 * the poll, which stores it as it is now (REJECTED: EDITED, or OUTGOING for the account's own).
 * Logs: source and error code only.
 */
export class ListenerUpdates {
  private readonly logger = new Logger('BankFeedListener');
  private readonly pending = new Map<string, BankFeedNudge>();

  constructor(private readonly deps: ListenerUpdatesDeps) {}

  get pendingAnomalies(): number {
    return this.pending.size;
  }

  nudge(nudge: BankFeedNudge): void {
    if (!this.deps.mayRead()) return;
    this.deps.poller.poll(nudge.source, this.deps.mayRead).catch((error: unknown) => {
      if (fatalCodeOf(error) !== null) return this.deps.fatal(error);
      this.logger.warn(`bank-feed nudge poll source=${nudge.source} failed: ${errorCode(error)}`);
      return undefined;
    });
  }

  edit(nudge: BankFeedNudge): void {
    if (!this.deps.leading()) return;
    this.edited(nudge).catch((error: unknown) => {
      this.logger.warn(`bank-feed edit source=${nudge.source} failed: ${errorCode(error)}`);
    });
  }

  /** Raises the edit anomalies that failed before (each lock tick, while this worker leads). */
  async retryPending(): Promise<void> {
    if (!this.deps.leading()) return;
    for (const nudge of [...this.pending.values()]) {
      await this.raise(nudge).catch((error: unknown) => {
        this.logger.warn(`bank-feed edit anomaly retry failed: ${errorCode(error)}`);
      });
    }
  }

  private async edited(nudge: BankFeedNudge): Promise<void> {
    // Looked up by the source's chat, not by the bot as sender: the account's own (OUTGOING) row
    // carries the account's id as senderId (review M1). An unpinned source stores nothing.
    const pinned = this.deps.pinnedBot(nudge.source) !== null;
    const stored = pinned
      ? await this.deps.messages.storedMessage(nudge.source, nudge.messageId)
      : null;
    if (stored === null) {
      this.nudge(nudge);
      return;
    }
    this.logger.warn(`bank-feed message ${stored.id} was edited after it was stored`);
    await this.deps.alerts.send('edited', stored.id); // never throws: kept and retried itself
    if (stored.rejectReason === 'OUTGOING') await this.raise(nudge);
  }

  private async raise(nudge: BankFeedNudge): Promise<void> {
    const key = `${nudge.source}/${nudge.messageId.toString()}`;
    try {
      await this.deps.anomaly.raise(nudge.source, 'OUTGOING', nudge.messageId, this.deps.now());
    } catch (error) {
      if (this.pending.size < PENDING_MAX || this.pending.has(key)) this.pending.set(key, nudge);
      throw error;
    }
    this.pending.delete(key);
  }
}
