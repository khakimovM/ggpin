import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import type { BankFeedListenerClient } from './bank-feed-client';
import type { IngestService } from './ingest.service';
import type { ListenerRepository } from './listener.repository';

/** Messages read per history call. */
export const POLL_PAGE = 100;
/** Pages per source in one poll; the rest is read by the next poll (not an error). */
export const POLL_MAX_PAGES = 20;

/**
 * - END: read to the end of the chat (an empty page);
 * - PAGE_CAP: POLL_MAX_PAGES pages read, more next time;
 * - FOREIGN_CHAT: the client returned another chat's message: nothing past it is ingested, the
 *   source is not healthy (ingest alerted `foreignChat`), the poll is not a heartbeat;
 * - NO_PROGRESS: the client returned nothing above the cursor;
 * - NOT_PINNED: the source has no bot id (fake mode without one): never healthy;
 * - NOT_LEADER: the caller's guard said this worker may no longer read (D-52): stopped between
 *   pages, never healthy;
 * - BLIND: the history read says "nothing after the cursor" while the chat's newest message id is
 *   above it, twice in a row (D-52 r2, review M-C: a paging bug would otherwise look healthy while
 *   no payment is read). Unhealthy until a check passes, so no heartbeat, the API stops new
 *   requests and the watchdog alerts `listenerDown`.
 */
export type PollOutcome =
  'END' | 'PAGE_CAP' | 'FOREIGN_CHAT' | 'NO_PROGRESS' | 'NOT_PINNED' | 'NOT_LEADER' | 'BLIND';

/** How often an END is checked against the chat's newest message id (once blind: every poll). */
export const BLIND_CHECK_MS = 5 * 60_000;

const HEALTHY: readonly PollOutcome[] = ['END', 'PAGE_CAP'];

export function isHealthyPoll(outcome: PollOutcome): boolean {
  return HEALTHY.includes(outcome);
}

/** Checked before every history call: false stops the poll (lock lost, lease too old). */
export type PollGuard = () => boolean;

/**
 * The history poll of the listener (docs/05 §4: the MAIN channel; live updates only nudge it).
 * Per source, one poll at a time, and at most ONE waiting behind it (D-52 M3): a nudge while a
 * poll waits joins that waiting poll instead of queueing another. Messages are ingested strictly
 * in ascending id order (S6 I3), each through the ordinary IngestService (filter, parse, store
 * with the cursor in one transaction, `bank-message` job), so a message seen by an update and by
 * a poll is still one row. The start point is the stored cursor (BankFeedCursor), or the last id
 * this process got past, whichever is higher.
 *
 * A source with no cursor at all (the very first start) does not walk the chat's history
 * (D-52 M2): the newest message id is read with one call and written as the cursor, and only
 * later messages are polled. Older messages are the daily re-scan's (its 48 h window; whatever
 * it stores is "stored late", D-47). A client or database error rejects; the cursor stays at the
 * last ingested message.
 */
export class BankFeedPoller {
  private readonly logger = new Logger('BankFeedPoller');
  private readonly passed = new Map<BankFeedSource, bigint>();
  private readonly checkedAt = new Map<BankFeedSource, number>();
  private readonly blind = new Set<BankFeedSource>();
  private readonly running = new Map<BankFeedSource, Promise<PollOutcome>>();
  private readonly waiting = new Map<BankFeedSource, Promise<PollOutcome>>();

  constructor(
    private readonly client: Pick<BankFeedListenerClient, 'fetchSince' | 'latestMessageId'>,
    private readonly ingest: Pick<IngestService, 'ingest' | 'pinnedBot'>,
    private readonly cursors: Pick<ListenerRepository, 'cursor' | 'initCursor'>,
    private readonly maxPages: number = POLL_MAX_PAGES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  poll(source: BankFeedSource, guard: PollGuard = () => true): Promise<PollOutcome> {
    const waiting = this.waiting.get(source);
    if (waiting !== undefined) return waiting;
    const running = this.running.get(source);
    if (running === undefined) return this.launch(source, guard);
    const next = running
      .catch(() => undefined)
      .then(() => {
        this.waiting.delete(source);
        return this.launch(source, guard);
      });
    this.waiting.set(source, next);
    return next;
  }

  private launch(source: BankFeedSource, guard: PollGuard): Promise<PollOutcome> {
    const run = this.run(source, guard);
    this.running.set(source, run);
    const done = (): void => {
      if (this.running.get(source) === run) this.running.delete(source);
    };
    run.then(done, done);
    return run;
  }

  private async run(source: BankFeedSource, guard: PollGuard): Promise<PollOutcome> {
    if (this.ingest.pinnedBot(source) === null) return 'NOT_PINNED';
    if (!guard()) return 'NOT_LEADER';
    let cursor = await this.startPoint(source);
    for (let page = 0; page < this.maxPages; page += 1) {
      if (!guard()) return 'NOT_LEADER';
      const messages = await this.client.fetchSince(source, cursor, POLL_PAGE);
      if (messages.length === 0) return this.atEnd(source, cursor, guard);
      const ordered = [...messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const startedAt = cursor;
      for (const message of ordered) {
        if (message.id <= cursor) continue;
        const result = await this.ingest.ingest(source, message);
        if (!result.stored && result.reason === 'FOREIGN_CHAT') return 'FOREIGN_CHAT';
        cursor = message.id;
        this.passed.set(source, cursor);
      }
      if (cursor <= startedAt) return 'NO_PROGRESS';
    }
    return 'PAGE_CAP';
  }

  /**
   * An empty page: the end, unless the chat's newest id says otherwise (M-C). Checked every
   * BLIND_CHECK_MS per source, and on every poll while the source is blind. A message that
   * arrived between the two reads is not blindness: the second read returns it.
   */
  private async atEnd(source: BankFeedSource, cursor: bigint, guard: PollGuard) {
    const now = this.now().getTime();
    const last = this.checkedAt.get(source);
    const due = this.blind.has(source) || last === undefined || now - last >= BLIND_CHECK_MS;
    if (!due) return 'END' as const;
    if (!guard()) return 'NOT_LEADER' as const;
    const latest = await this.client.latestMessageId(source);
    this.checkedAt.set(source, now);
    if (latest === null || latest <= cursor) {
      if (this.blind.delete(source)) this.logger.warn(`bank-feed source=${source} reads again`);
      return 'END' as const;
    }
    if ((await this.client.fetchSince(source, cursor, POLL_PAGE)).length > 0) return 'END' as const;
    if (!this.blind.has(source)) {
      this.logger.error(
        `bank-feed source=${source}: history read finds nothing past the cursor, ` +
          'but newer messages exist: BLIND (no heartbeat)',
      );
    }
    this.blind.add(source);
    return 'BLIND' as const;
  }

  private async startPoint(source: BankFeedSource): Promise<bigint> {
    const passed = this.passed.get(source) ?? 0n;
    const stored = await this.cursors.cursor(source);
    if (stored !== null) return stored > passed ? stored : passed;
    // First start of this source: begin at the newest message, do not replay the chat (M2).
    const latest = (await this.client.latestMessageId(source)) ?? 0n;
    const start = latest > passed ? latest : passed;
    await this.cursors.initCursor(source, start);
    this.passed.set(source, start);
    return start;
  }
}
