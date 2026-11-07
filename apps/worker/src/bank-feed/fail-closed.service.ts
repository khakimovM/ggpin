import { Inject, Injectable, Logger } from '@nestjs/common';
import { BankFeedEffects } from './bank-feed-effects';
import { BankFeedNotifier } from './bank-feed-notifier';
import { BankMessageRepository } from './bank-message.repository';
import { MatchWritesRepository } from './match-writes.repository';
import { TopupCardsRepository } from './topup-cards.repository';

/** DI token of the fail-closed waits; tests shorten them. */
export const FAIL_CLOSED_TIMING = Symbol('FAIL_CLOSED_TIMING');

export interface FailClosedTiming {
  /** `lock_timeout` of one try: longer than the matcher's, the card is likely what failed it. */
  readonly lockWaitMs: number;
  readonly tries: number;
  /** Pause between tries. */
  readonly pauseMs: number;
}

export const DEFAULT_FAIL_CLOSED_TIMING: FailClosedTiming = {
  lockWaitMs: 10_000,
  tries: 3,
  pauseMs: 1_000,
};

const TX_OPTIONS = { maxWait: 4_000, timeout: 15_000 } as const;

/**
 * - FAILED_CLOSED: the review is written and its effects (alert, limit job) are queued;
 * - HAS_OUTCOME: the message already has its decision (the failure was after the commit);
 * - STUCK_ALERTED: no try could write the review; the owner got `messageStuck` (ids only).
 */
export type FailClosedResult = 'FAILED_CLOSED' | 'HAS_OUTCOME' | 'STUCK_ALERTED';

/**
 * The fail-closed end of a message whose every attempt failed unexpectedly (docs/05 §6): a short
 * separate transaction writes review UNRECOGNIZED / PROCESSING_FAILED (the "not understood, a
 * human decides" kind; CHAIN_BREAK or AMBIGUOUS would claim a cause nobody established) with
 * its REVIEW outcome and pauses the card's auto-credit; then the effects raise the alert. The
 * write is tried several times with a longer lock wait (the original failure is often a busy
 * card, m-2); when it still cannot be written, the owner is alerted without any database write.
 */
@Injectable()
export class FailClosedService {
  private readonly logger = new Logger(FailClosedService.name);

  constructor(
    private readonly reads: BankMessageRepository,
    private readonly writes: MatchWritesRepository,
    private readonly cards: TopupCardsRepository,
    private readonly effects: BankFeedEffects,
    private readonly notifier: BankFeedNotifier,
    @Inject(FAIL_CLOSED_TIMING) private readonly timing: FailClosedTiming,
  ) {}

  async close(bankMessageId: string): Promise<FailClosedResult> {
    let written: boolean | null = null;
    for (let attempt = 1; attempt <= this.timing.tries && written === null; attempt += 1) {
      try {
        written = await this.writeReview(bankMessageId);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        this.logger.warn(`fail-closed message=${bankMessageId} try=${String(attempt)}: ${name}`);
        if (attempt < this.timing.tries) await pause(this.timing.pauseMs);
      }
    }
    if (written === null) {
      await this.notifier.alert('messageStuck', bankMessageId);
      return 'STUCK_ALERTED';
    }
    if (!written) return 'HAS_OUTCOME';
    await this.effects.run(bankMessageId);
    return 'FAILED_CLOSED';
  }

  /** True when the review was written now, false when an outcome already exists. */
  private async writeReview(bankMessageId: string): Promise<boolean> {
    const message = await this.reads.findMessage(bankMessageId);
    if (message === null || message.outcome !== null) return false;
    const cardId = message.cardId;
    return this.reads.client.$transaction(async (tx) => {
      await this.cards.setLockTimeout(tx, this.timing.lockWaitMs);
      if (cardId !== null) await this.cards.lockCard(tx, cardId);
      if (await this.reads.hasOutcome(tx, bankMessageId)) return false;
      if (cardId !== null) await this.writes.pauseAutoCredit(tx, cardId);
      const review = {
        bankMessageId,
        kind: 'UNRECOGNIZED',
        cardId,
        note: 'PROCESSING_FAILED',
      } as const;
      await this.writes.review(tx, review, 'NOT_APPLICABLE');
      return true;
    }, TX_OPTIONS);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
