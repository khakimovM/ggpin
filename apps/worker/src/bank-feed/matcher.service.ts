import { Inject, Injectable } from '@nestjs/common';
import type { BankMessage, Tx } from '@repo/db';
import { BANK_FEED_DEFAULTS } from '@repo/shared';
import { BankFeedEffects } from './bank-feed-effects';
import { BankMessageRepository } from './bank-message.repository';
import { CreditDecider, type ParsedOnCard } from './credit-decider';
import { chainVerdict } from './match-rules';
import { MATCHER_HOOKS, type MatcherHooks } from './matcher-hooks';
import { MatchWritesRepository } from './match-writes.repository';
import { MessageIntegrity } from './message-integrity';
import { isUniqueViolation } from './prisma-errors';
import { TopupCardsRepository } from './topup-cards.repository';

/** An earlier message of the card is not processed yet: wait (the processor delays the job). */
export class PredecessorPendingError extends Error {
  constructor(readonly bankMessageId: string) {
    super(`bank message ${bankMessageId} waits for an earlier message of its card`);
    this.name = 'PredecessorPendingError';
  }
}

export class BankMessageNotFoundError extends Error {
  constructor(readonly bankMessageId: string) {
    super(`bank message ${bankMessageId} does not exist`);
    this.name = 'BankMessageNotFoundError';
  }
}

export type ProcessResult = 'PROCESSED' | 'ALREADY_PROCESSED';

const TX_OPTIONS = { maxWait: 4_000, timeout: 15_000 } as const;

/**
 * Processes one stored bank message (docs/05 §6): decides credit / card verification / debit /
 * review in ONE transaction that also writes its BankMessageOutcome, then runs the post-commit
 * effects. Idempotent: an existing outcome means "done", and the effects are re-derived from it
 * (their job ids make them happen once), so a crash after the commit loses nothing.
 *
 * Locks (rules/20), in this order: `lock_timeout` set, the card's advisory lock
 * (`lockTopupCard`, the API's key; ONE card lock per transaction), the intent row FOR UPDATE,
 * the Wallet row. Processors of one card are serialised, so two workers on one message cannot
 * both credit; the unique keys (outcome, Payment.bankMessageId, ledger) are the second line.
 * Only a unique violation (P2002) with an outcome present counts as "settled by another
 * processor"; anything else (an exclusion violation 23P01 included) is an error, and on the
 * job's last attempt FailClosedService turns it into a review.
 */
@Injectable()
export class MatcherService {
  constructor(
    private readonly reads: BankMessageRepository,
    private readonly writes: MatchWritesRepository,
    private readonly cards: TopupCardsRepository,
    private readonly integrity: MessageIntegrity,
    private readonly credits: CreditDecider,
    private readonly effects: BankFeedEffects,
    @Inject(MATCHER_HOOKS) private readonly hooks: MatcherHooks,
  ) {}

  /** `waitedOut`: the job has waited for earlier messages as long as it may (processor). */
  async process(bankMessageId: string, waitedOut: boolean): Promise<ProcessResult> {
    const message = await this.reads.findMessage(bankMessageId);
    if (message === null) throw new BankMessageNotFoundError(bankMessageId);
    let result: ProcessResult = 'ALREADY_PROCESSED';
    if (message.outcome === null) {
      try {
        result = await this.reads.client.$transaction(async (tx) => {
          await this.cards.setLockTimeout(tx);
          return this.decide(tx, message, waitedOut);
        }, TX_OPTIONS);
      } catch (error) {
        // A parallel processor wrote first: its outcome stands, ours rolled back whole.
        const settled =
          isUniqueViolation(error) &&
          (await this.reads.hasOutcome(this.reads.client, bankMessageId));
        if (!settled) throw error;
        await this.hooks.settledByOther(bankMessageId);
      }
    }
    await this.effects.run(bankMessageId);
    return result;
  }

  private async decide(tx: Tx, message: BankMessage, waitedOut: boolean): Promise<ProcessResult> {
    const id = message.id;
    if (message.parseStatus !== 'PARSED') {
      const kind = message.parseStatus === 'REJECTED' ? 'REJECTED' : 'UNRECOGNIZED';
      await this.writes.review(
        tx,
        { bankMessageId: id, kind, cardId: message.cardId },
        'NOT_APPLICABLE',
      );
      return this.commit(tx, id);
    }
    const parsed = asParsedOnCard(message);
    if (parsed === null) {
      const review = { bankMessageId: id, kind: 'CARD_UNKNOWN', cardId: null } as const;
      await this.writes.review(tx, review, 'NOT_APPLICABLE');
      return this.commit(tx, id);
    }
    const cardId = parsed.cardId;
    await this.cards.lockCard(tx, cardId);
    await this.hooks.afterCardLock(tx, cardId);
    if (await this.reads.hasOutcome(tx, id)) return 'ALREADY_PROCESSED';
    const card = await this.reads.findCard(tx, cardId);
    if (card === null) throw new Error(`card ${cardId} of message ${id} is missing`);
    if (card.status === 'RETIRED') {
      await this.writes.review(
        tx,
        { bankMessageId: id, kind: 'CARD_RETIRED', cardId },
        'NOT_APPLICABLE',
      );
      return this.commit(tx, id);
    }
    const anomaly = await this.integrity.check(tx, message);
    if (anomaly !== null) {
      // Not from the pinned bot, or not the text that was stored: never credited, card stopped.
      await this.writes.pauseAutoCredit(tx, cardId);
      const review = { bankMessageId: id, kind: 'UNRECOGNIZED', cardId, note: anomaly } as const;
      await this.writes.review(tx, review, 'NOT_APPLICABLE');
      return this.commit(tx, id);
    }
    if (await this.reads.hasUnprocessedPredecessor(tx, parsed)) {
      if (!waitedOut) throw new PredecessorPendingError(id);
      // Waited as long as allowed and the chain still cannot be checked: never credit, stop.
      await this.writes.pauseAutoCredit(tx, cardId);
      const review = {
        bankMessageId: id,
        kind: 'CHAIN_BREAK',
        cardId,
        note: 'PREDECESSOR_PENDING',
      } as const;
      await this.writes.review(tx, review, 'BREAK');
      return this.commit(tx, id);
    }
    const previous = await this.reads.previousParsed(tx, parsed);
    const previousBalance = previous?.balanceAfterTiyin ?? null;
    const chain = chainVerdict(
      previousBalance === null ? null : { balanceAfterTiyin: previousBalance },
      parsed,
    );
    if (chain === 'BREAK') {
      await this.writes.pauseAutoCredit(tx, cardId);
      await this.writes.review(tx, { bankMessageId: id, kind: 'CHAIN_BREAK', cardId }, 'BREAK');
      return this.commit(tx, id);
    }
    if (parsed.direction === 'DEBIT') await this.decideDebit(tx, parsed, chain);
    else await this.credits.decide(tx, parsed, card, chain);
    return this.commit(tx, id);
  }

  private async commit(tx: Tx, bankMessageId: string): Promise<ProcessResult> {
    await this.hooks.beforeCommit(tx, bankMessageId);
    return 'PROCESSED';
  }

  /** Money left the card: never touches a wallet; equal to a recent payment = possible reversal. */
  private async decideDebit(tx: Tx, message: ParsedOnCard, chain: 'FIRST' | 'OK'): Promise<void> {
    const windowMs = BANK_FEED_DEFAULTS.REVERSAL_WINDOW_SEC * 1000;
    const since = new Date(message.tgDate.getTime() - windowMs);
    const payment = await this.reads.recentPayment(tx, message.cardId, message.amountTiyin, since);
    if (payment === null) {
      await this.writes.writeOutcome(tx, {
        bankMessageId: message.id,
        chainStatus: chain,
        outcome: 'DEBIT_RECORDED',
      });
      return;
    }
    const review = {
      bankMessageId: message.id,
      kind: 'POSSIBLE_REVERSAL',
      cardId: message.cardId,
      ...(payment.intentId === null ? {} : { intentId: payment.intentId }),
    } as const;
    await this.writes.review(tx, review, chain);
  }
}

/** The parsed fields with their CHECK-guaranteed non-null types; null when there is no card. */
function asParsedOnCard(message: BankMessage): ParsedOnCard | null {
  const { direction, amountTiyin, balanceAfterTiyin, last4, bankTxnAt, cardId } = message;
  if (
    direction === null ||
    amountTiyin === null ||
    balanceAfterTiyin === null ||
    last4 === null ||
    bankTxnAt === null
  ) {
    throw new Error(`PARSED bank message ${message.id} lacks parsed fields`);
  }
  if (cardId === null) return null;
  return { ...message, direction, amountTiyin, balanceAfterTiyin, last4, bankTxnAt, cardId };
}
