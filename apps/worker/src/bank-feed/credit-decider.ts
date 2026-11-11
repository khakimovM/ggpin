import { Inject, Injectable } from '@nestjs/common';
import type { BankMessage, TopupCard, Tx } from '@repo/db';
import { checkDailyTopupLimit, dailyWindowStart, reservedUntilWhenPaid } from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { BankMessageRepository, type IntentWithUser } from './bank-message.repository';
import {
  classifyCandidates,
  isLateForClosedRequest,
  isTimeSkewed,
  type CandidateVerdict,
} from './match-rules';
import { MATCHER_HOOKS, type MatcherHooks } from './matcher-hooks';
import { MatchWritesRepository } from './match-writes.repository';
import { checkCreditTitle } from './title-check';
import { TopupCardsRepository } from './topup-cards.repository';

/** A PARSED message with a card, its CHECK-guaranteed fields narrowed to non-null. */
export type ParsedOnCard = BankMessage & {
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
  readonly last4: string;
  readonly bankTxnAt: Date;
  readonly cardId: string;
};

type Chain = 'FIRST' | 'OK';

/**
 * The CREDIT branch of the matcher (docs/05 §6 steps 5-8), run inside the matcher's transaction
 * under the card lock, after the chain was found intact. Everything that is not provably one
 * payable intent becomes a review; only `credit()` moves money.
 */
@Injectable()
export class CreditDecider {
  constructor(
    private readonly reads: BankMessageRepository,
    private readonly writes: MatchWritesRepository,
    private readonly cards: TopupCardsRepository,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(MATCHER_HOOKS) private readonly hooks: MatcherHooks,
  ) {}

  async decide(tx: Tx, message: ParsedOnCard, card: TopupCard, chain: Chain): Promise<void> {
    const base = { bankMessageId: message.id, cardId: card.id };
    if (card.autoCreditPaused) {
      await this.writes.review(tx, { ...base, kind: 'AUTO_CREDIT_PAUSED' }, chain);
      return;
    }
    if (card.status === 'VERIFYING') {
      await this.verifyCard(tx, message, card, chain);
      return;
    }
    if (isTimeSkewed(message.bankTxnAt, message.tgDate, this.config.BANK_TIME_SKEW_SEC)) {
      await this.writes.review(tx, { ...base, kind: 'TIME_SKEW' }, chain);
      return;
    }
    const first = await this.verdict(tx, message);
    if (first.kind !== 'CREDIT') {
      await this.reviewVerdict(tx, message, first, chain);
      return;
    }
    // Lock the intent row, then look again: the API may have cancelled it in between, and from
    // here on the locked row cannot change any more.
    await this.hooks.beforeIntentLock(tx, first.intentId);
    const locked = await this.reads.lockIntent(tx, first.intentId);
    const again = await this.verdict(tx, message);
    if (locked === null || again.kind !== 'CREDIT' || again.intentId !== locked.id) {
      await this.reviewVerdict(tx, message, again, chain);
      return;
    }
    await this.creditOrReview(tx, message, locked, chain);
  }

  /**
   * VERIFYING card: its exact test amount, sent after the card was added, activates it (no
   * ledger); anything else is reviewed. The date check keeps an older transfer of the same
   * amount (found by a history re-scan) from verifying the card (S9-L1).
   */
  private async verifyCard(tx: Tx, message: ParsedOnCard, card: TopupCard, chain: Chain) {
    if (message.amountTiyin !== card.verifyAmountTiyin || message.tgDate < card.createdAt) {
      await this.writes.review(
        tx,
        { bankMessageId: message.id, cardId: card.id, kind: 'NO_MATCH' },
        chain,
      );
      return;
    }
    // The test transfer counts as received from here on (verifiedAt = its arrival).
    await this.writes.activate(tx, card.id, message.tgDate);
    await this.writes.writeOutcome(tx, {
      bankMessageId: message.id,
      chainStatus: chain,
      outcome: 'CARD_VERIFIED',
    });
  }

  private async verdict(tx: Tx, message: ParsedOnCard): Promise<CandidateVerdict> {
    const rows = await this.reads.candidates(
      tx,
      message.cardId,
      message.amountTiyin,
      message.tgDate,
    );
    return classifyCandidates(rows);
  }

  private async reviewVerdict(
    tx: Tx,
    message: ParsedOnCard,
    verdict: CandidateVerdict,
    chain: Chain,
  ): Promise<void> {
    const base = { bankMessageId: message.id, cardId: message.cardId };
    if (verdict.kind === 'CANCELLED_LATE') {
      await this.writes.review(
        tx,
        { ...base, kind: 'CANCELLED_LATE', intentId: verdict.intentId },
        chain,
      );
    } else if (verdict.kind === 'CREDIT') {
      // The candidate changed between the read and the lock: never guess whose money it is.
      await this.writes.review(
        tx,
        { ...base, kind: 'AMBIGUOUS', intentId: verdict.intentId },
        chain,
      );
    } else if (verdict.kind === 'AMBIGUOUS') {
      await this.writes.review(tx, { ...base, kind: 'AMBIGUOUS' }, chain);
    } else {
      const holder = await this.reads.paidHolder(
        tx,
        message.cardId,
        message.amountTiyin,
        message.tgDate,
      );
      await this.writes.review(
        tx,
        holder === null
          ? { ...base, kind: 'NO_MATCH' }
          : { ...base, kind: 'DUPLICATE', intentId: holder.id },
        chain,
      );
    }
  }

  /**
   * Step 7: the last checks on exactly one PENDING / EXPIRED intent (row locked), then the credit.
   * The Wallet row is locked first (card -> intent -> wallet), so the daily cap of one user is
   * computed and spent by one processor at a time even when two cards pay the same user.
   */
  private async creditOrReview(
    tx: Tx,
    message: ParsedOnCard,
    intent: IntentWithUser,
    chain: Chain,
  ): Promise<void> {
    const base = { bankMessageId: message.id, cardId: message.cardId, intentId: intent.id };
    await this.cards.lockWallet(tx, intent.userId);
    if (await this.amountReallocated(tx, message, intent)) {
      const review = { ...base, kind: 'AMBIGUOUS', note: 'AMOUNT_REALLOCATED' } as const;
      await this.writes.review(tx, review, chain);
      return;
    }
    // D-43 (1): an unknown title is never credited automatically, even with an exact match.
    const title = checkCreditTitle(message, await this.reads.rawText(tx, message.id));
    if (!title.ok) {
      await this.writes.review(tx, { ...base, kind: 'UNRECOGNIZED', note: title.note }, chain);
      return;
    }
    // D-47: stored late (re-scan or a listener catching up) for a request that was no longer
    // open when the row was stored: the owner may already have credited it by hand during the
    // outage, so the owner decides. "Open" is PENDING and not yet past `expiresAt` at storing
    // time: the sweep runs in this worker too, so after an outage an overdue request may still
    // say PENDING (B1). Late money for a request still open then is credited: the user was still
    // waiting on it, and nobody credits an open request by hand. After the title check, so an
    // anomaly note (TITLE_UNKNOWN, REPARSE_MISMATCH, TEXT_MISSING) is never hidden by this one.
    if (isLateForClosedRequest(message, intent)) {
      await this.writes.review(tx, { ...base, kind: 'AMBIGUOUS', note: 'LATE_STORED' }, chain);
      return;
    }
    if (intent.user.isBlocked) {
      await this.writes.review(tx, { ...base, kind: 'USER_BLOCKED' }, chain);
      return;
    }
    const now = new Date();
    if (intent.baseAmountTiyin === null) throw new Error(`P2P intent ${intent.id} has no base`);
    // The creation-time formula again (D-37 (7)): this intent is the request, so it is not
    // counted among the used amounts.
    const limit = checkDailyTopupLimit({
      usedBaseTiyin: await this.cards.usedBaseSince(
        tx,
        intent.userId,
        dailyWindowStart(now),
        intent.id,
      ),
      requestedBaseTiyin: intent.baseAmountTiyin,
      isNewAccount:
        now.getTime() - intent.user.createdAt.getTime() <
        this.config.TOPUP_NEW_ACCOUNT_AGE_SEC * 1000,
      dailyMaxTiyin: this.config.TOPUP_DAILY_MAX_TIYIN,
      newAccountDailyMaxTiyin: this.config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN,
    });
    if (!limit.ok) {
      await this.writes.review(tx, { ...base, kind: 'DAILY_LIMIT', note: limit.reason }, chain);
      return;
    }
    // D-47 R1, the last gate before money, for every automatic credit (live, re-scan, re-queued;
    // PENDING or EXPIRED in grace): the owner gave this user money by hand after the request was
    // made (e.g. after a messageStuck alert), so this transfer may already be paid. Read under
    // the Wallet lock taken above, which wallet:adjust and review:credit take too: a hand credit
    // either committed before (seen here) or waits until this transaction ends.
    if (await this.reads.manualCreditSince(tx, intent.userId, intent.createdAt)) {
      const review = { ...base, kind: 'AMBIGUOUS', note: 'MANUAL_CREDIT_SEEN' } as const;
      await this.writes.review(tx, review, chain);
      return;
    }
    await this.writes.credit(tx, message, intent, chain, now);
  }

  /**
   * A late payment extends the reservation to `paidAt + grace` (reservedUntilWhenPaid). When the
   * amount was meanwhile handed to a newer request on the card, that extension would overlap it
   * (EXCLUDE, 23P01) and two people would hold one amount: whose money it is is for the owner.
   */
  private async amountReallocated(tx: Tx, message: ParsedOnCard, intent: IntentWithUser) {
    const reservedUntil = intent.reservedUntil;
    if (reservedUntil === null) throw new Error(`P2P intent ${intent.id} has no reservation`);
    const until = reservedUntilWhenPaid(
      { expiresAt: intent.expiresAt, reservedUntil },
      message.tgDate,
    );
    return (await this.reads.overlappingIntent(tx, intent, until)) !== null;
  }
}
