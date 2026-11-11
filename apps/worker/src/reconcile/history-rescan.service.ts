import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  alertRef,
  type BankFeedSource,
  type ReconcileHistoryReason,
  type ReconcileHistoryState,
} from '@repo/shared';
import { BankFeedNotifier } from '../bank-feed/bank-feed-notifier';
import { BANK_FEED_CLIENT, type BankFeedClient } from '../bank-feed/client/bank-feed-client';
import { BANK_FEED_LISTENER } from '../bank-feed/client/bank-feed-client.provider';
import type { BankFeedListener } from '../bank-feed/client/bank-feed-listener';
import { IngestService } from '../bank-feed/client/ingest.service';
import { LATE_STORED_AFTER_MS } from '../bank-feed/match-rules';
import { ReconcileRepository } from './reconcile.repository';

/** Messages read per history call. */
export const RESCAN_PAGE = 100;
/** A re-scan reads at most this many pages per source (5 000 messages); more is `failed`. */
export const RESCAN_MAX_PAGES = 50;
/**
 * Extra age a message must have before the re-scan stores it (S9 security I1): "late" is judged by
 * the row (Postgres now() minus Telegram's date, isLateStored) but this filter uses the worker's
 * clock. With Postgres on another host the two clocks may differ; a minute of margin keeps every
 * message this path stores late by its own row.
 */
export const RESCAN_CLOCK_MARGIN_MS = 60_000;

export interface SourceRescan {
  readonly state: ReconcileHistoryState;
  /** Why it is not `ok` (null when it is); kept in the audit and listed in the mismatch alert. */
  readonly reason: ReconcileHistoryReason | null;
  /** Messages the client returned. */
  readonly fetched: number;
  /** Ids stored now by the ordinary ingest path (the listener had missed them). */
  readonly recovered: readonly string[];
}

export interface HistoryRescan {
  /** ok only when every source was read to the end. */
  readonly state: ReconcileHistoryState;
  readonly sources: Readonly<Record<BankFeedSource, SourceRescan>>;
}

const unavailable = (reason: ReconcileHistoryReason): SourceRescan => ({
  state: 'unavailable',
  reason,
  fetched: 0,
  recovered: [],
});

/**
 * The 48 h history re-scan of the daily reconciliation (docs/05 §10): each bank bot's chat is
 * read again from the source's last stored message older than the window; a message whose id is
 * not stored goes through the ordinary ingest path (filter, parse, store, `bank-message` job)
 * in id order, and the matcher decides it (a late one for a request no longer PENDING goes to
 * review, D-47). Skipped: messages younger than LATE_STORED_AFTER_MS + RESCAN_CLOCK_MARGIN_MS (the listener's), and on a
 * source's first re-scan (nothing stored before the window) messages dated before the window.
 * Without a client (BANK_FEED_MODE off) or a pinned bot id the source is `unavailable`, and so
 * it is while a listener exists but this worker does not lead, or leads without an authorization
 * check of the last 2 poll intervals (NOT_LEADER, D-52 r2 L-A: `mayRead`, checked before every
 * page, r3 I-B; only the leader is connected; the client refuses reads otherwise, and a second
 * connection must never open); a client error, a history longer than RESCAN_MAX_PAGES, or a page carrying a
 * message of another chat (S9F-I2: the client broke its contract; nothing of that page is
 * ingested and the cursor never moves past it; the owner gets the hourly `foreignChat` alert) is
 * `failed`. Neither is ever reported as `ok`; each source keeps its reason code.
 * Logs: the source, the state and counts; never a text, amount or card digit.
 */
@Injectable()
export class HistoryRescanService {
  private readonly logger = new Logger(HistoryRescanService.name);

  constructor(
    @Inject(BANK_FEED_CLIENT) private readonly client: BankFeedClient | null,
    private readonly ingest: IngestService,
    private readonly repo: ReconcileRepository,
    private readonly notifier: BankFeedNotifier,
    /** null: no listener (mode off, or a suite that reads the client directly). */
    @Inject(BANK_FEED_LISTENER)
    private readonly listener: Pick<BankFeedListener, 'mayRead'> | null = null,
  ) {}

  async rescan(since: Date, now: Date): Promise<HistoryRescan> {
    // One key per source: a new source without its re-scan is a compile error.
    const sources = {
      HUMO_BOT: await this.source('HUMO_BOT', since, now),
      UZCARD_BOT: await this.source('UZCARD_BOT', since, now),
    } satisfies Record<BankFeedSource, SourceRescan>;
    const states = Object.values(sources).map((s) => s.state);
    const state: ReconcileHistoryState = states.includes('failed')
      ? 'failed'
      : states.includes('unavailable')
        ? 'unavailable'
        : 'ok';
    return { state, sources };
  }

  private async source(source: BankFeedSource, since: Date, now: Date): Promise<SourceRescan> {
    const client = this.client;
    const pinned = this.ingest.pinnedBot(source);
    if (client === null) return unavailable('NO_CLIENT');
    if (pinned === null) return unavailable('NOT_PINNED');
    if (!this.mayRead()) return unavailable('NOT_LEADER');
    const recovered: string[] = [];
    let fetched = 0;
    const failed = (reason: ReconcileHistoryReason): SourceRescan => ({
      state: 'failed',
      reason,
      fetched,
      recovered,
    });
    try {
      const before = await this.repo.lastIdBefore(source, since);
      // First re-scan of a source (nothing stored before the window): the chat's older history
      // is not ours to replay, so only messages dated inside the window are ingested.
      const firstScan = before === null;
      let cursor = before ?? 0n;
      for (let page = 0; page < RESCAN_MAX_PAGES; page += 1) {
        // Before EVERY page (r3, audit I-B): a lead or a fresh authorization check lost mid-scan
        // stops the read at once; what was already stored stays, the source is not ok.
        if (!this.mayRead()) {
          this.logger.warn(`history re-scan source=${source} stopped: NOT_LEADER`);
          return { state: 'unavailable', reason: 'NOT_LEADER', fetched, recovered };
        }
        const messages = await client.fetchSince(source, cursor, RESCAN_PAGE);
        // Only an empty page ends the history (the client contract): a short one may not be last.
        if (messages.length === 0) return { state: 'ok', reason: null, fetched, recovered };
        fetched += messages.length;
        if (messages.some((m) => m.chatId !== pinned)) {
          this.logger.error(`history re-scan source=${source} page has another chat: FOREIGN_CHAT`);
          await this.foreignChatAlert(source, now);
          return failed('FOREIGN_CHAT');
        }
        const known = await this.repo.knownIds(
          source,
          messages.map((m) => m.id),
        );
        const ordered = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const message of ordered) {
          if (known.has(message.id)) continue;
          if (firstScan && message.date < since) continue;
          // Too young: the listener stores it live (or the next day's re-scan does). So every
          // message this path stores is "stored late" by its own row (D-47).
          const age = now.getTime() - message.date.getTime();
          if (age <= LATE_STORED_AFTER_MS + RESCAN_CLOCK_MARGIN_MS) continue;
          const stored = await this.ingest.ingest(source, message, now);
          if (stored.stored) recovered.push(stored.bankMessageId);
        }
        const lastId = ordered[ordered.length - 1]?.id ?? cursor;
        if (lastId <= cursor) {
          // A client that does not move forward: stop, report failed.
          this.logger.warn(`history re-scan source=${source} stopped: NO_PROGRESS`);
          return failed('NO_PROGRESS');
        }
        cursor = lastId;
      }
      this.logger.warn(`history re-scan source=${source} stopped before the end: TOO_LONG`);
      return failed('TOO_LONG');
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      this.logger.error(`history re-scan source=${source} failed: ${name}`);
      return failed('CLIENT_ERROR');
    }
  }

  /** No listener (mode off, direct-client suites), or it leads with a fresh check (r2 L-A). */
  private mayRead(): boolean {
    return this.listener === null || this.listener.mayRead();
  }

  /**
   * The same hourly `foreignChat` alert the listener's ingest raises (same refId, so one per
   * source an hour between them). Its own failure is logged: the source is failed either way.
   */
  private async foreignChatAlert(source: BankFeedSource, now: Date): Promise<void> {
    try {
      await this.notifier.alert('foreignChat', alertRef.foreignChat(source, now));
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      this.logger.error(`history re-scan source=${source} foreignChat alert failed: ${name}`);
    }
  }
}
