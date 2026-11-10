import { Logger } from '@nestjs/common';
import type { BankFeedSource } from '@repo/shared';
import type { AuthorizationsWatch } from './authorizations-watch';
import type { BankFeedListenerClient } from './bank-feed-client';
import { isHealthyPoll, type BankFeedPoller, type PollGuard } from './bank-feed-poller';
import type { BankFeedBeat } from './heartbeat';
import type { ListenerWatchdog } from './listener-alerts';
import { fatalCodeOf } from './mtcute-bank-feed.client';
import { errorCode } from './mtcute-types';

const SOURCES: readonly BankFeedSource[] = ['HUMO_BOT', 'UZCARD_BOT'];

export interface ListenerRoundDeps {
  readonly client: Pick<BankFeedListenerClient, 'listAuthorizations'>;
  readonly poller: Pick<BankFeedPoller, 'poll'>;
  readonly authorizations: Pick<AuthorizationsWatch, 'check'>;
  readonly beat: Pick<BankFeedBeat, 'beat'>;
  readonly watchdog: Pick<ListenerWatchdog, 'healthy'>;
  /** Leading with a fresh lease. */
  readonly guard: PollGuard;
  /** Stops the listener for good (a fatal error). */
  readonly fatal: (error: unknown) => Promise<void>;
  readonly now: () => Date;
  /** BANK_FEED_POLL_SEC in ms: a successful authorization check is fresh for twice this. */
  readonly pollMs: number;
}

/**
 * One listener round (docs/05 §4, D-52): the authorizations FIRST (a failed check reads nothing,
 * L-2), then both sources, and the heartbeat only when all of it was healthy (a BLIND source is
 * not, M-C). The time of the last successful authorization check is kept (D-52 r2, review L-A):
 * reads outside the round (live-update nudges, the history re-scan) need it to be at most two poll
 * intervals old, so a check that keeps failing stops them too. Logs: sources and error codes only.
 */
export class ListenerRound {
  private readonly logger = new Logger('BankFeedListener');
  private verifiedAt: number | null = null;

  constructor(private readonly deps: ListenerRoundDeps) {}

  /** A successful authorization check at most 2 x poll interval ago. */
  authorizationsFresh(): boolean {
    if (this.verifiedAt === null) return false;
    return this.deps.now().getTime() - this.verifiedAt <= 2 * this.deps.pollMs;
  }

  /** A new connection (or a stand-down): nothing is verified for it yet. */
  reset(): void {
    this.verifiedAt = null;
  }

  async run(): Promise<void> {
    if (!this.deps.guard()) return;
    const now = this.deps.now();
    try {
      await this.deps.authorizations.check(await this.deps.client.listAuthorizations(), now);
    } catch (error) {
      if (fatalCodeOf(error) !== null) return this.deps.fatal(error);
      // Unverified authorizations: nothing is read this round, no heartbeat (fail closed, L-2).
      this.logger.warn(`bank-feed authorizations check failed: ${errorCode(error)}`);
      return;
    }
    this.verifiedAt = now.getTime();
    let healthy = true;
    for (const source of SOURCES) {
      try {
        const outcome = await this.deps.poller.poll(source, this.deps.guard);
        if (!isHealthyPoll(outcome)) {
          healthy = false;
          this.logger.warn(`bank-feed poll source=${source}: ${outcome}`);
        }
      } catch (error) {
        if (fatalCodeOf(error) !== null) return this.deps.fatal(error);
        healthy = false;
        this.logger.warn(`bank-feed poll source=${source} failed: ${errorCode(error)}`);
      }
    }
    if (!healthy || !this.deps.guard()) return;
    try {
      await this.deps.beat.beat(now);
    } catch (error) {
      // No heartbeat written: not a healthy round (the API then refuses new requests).
      this.logger.warn(`bank-feed heartbeat not written: ${errorCode(error)}`);
      return;
    }
    this.deps.watchdog.healthy(now);
  }
}
