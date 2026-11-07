import { Injectable } from '@nestjs/common';
import {
  appendLedgerEntry,
  type BankMessage,
  type BankOutcome,
  type ChainStatus,
  type PaymentReviewKind,
  type Tx,
} from '@repo/db';
import {
  assertCardTransition,
  assertIntentTransition,
  isWithinGrace,
  reservedUntilWhenPaid,
  type ReviewNoteCode,
  type TopupCardStatus,
} from '@repo/shared';
import type { IntentWithUser } from './bank-message.repository';

export interface NewReview {
  readonly bankMessageId: string;
  readonly kind: PaymentReviewKind;
  readonly cardId: string | null;
  readonly intentId?: string;
  readonly note?: ReviewNoteCode;
}

export interface NewOutcome {
  readonly bankMessageId: string;
  readonly chainStatus: ChainStatus;
  readonly outcome: BankOutcome;
  readonly paymentId?: string;
  readonly reviewId?: string;
}

/** Thrown when the row changed between the read and the write: the transaction rolls back. */
export class StaleCardError extends Error {
  constructor(readonly cardId: string) {
    super(`card ${cardId} changed status concurrently`);
    this.name = 'StaleCardError';
  }
}

// Every write of the matcher. All of them run inside the caller's transaction; the card status
// writes and the crediting only under `lockTopupCard` (the caller takes it, ONE per transaction).
@Injectable()
export class MatchWritesRepository {
  async openReview(tx: Tx, review: NewReview): Promise<string> {
    const row = await tx.paymentReview.create({
      data: {
        bankMessageId: review.bankMessageId,
        kind: review.kind,
        cardId: review.cardId,
        intentId: review.intentId ?? null,
        note: review.note ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async writeOutcome(tx: Tx, outcome: NewOutcome): Promise<void> {
    await tx.bankMessageOutcome.create({
      data: {
        bankMessageId: outcome.bankMessageId,
        chainStatus: outcome.chainStatus,
        outcome: outcome.outcome,
        paymentId: outcome.paymentId ?? null,
        reviewId: outcome.reviewId ?? null,
      },
    });
  }

  /** Review + REVIEW outcome: the one shape of "not credited automatically". */
  async review(tx: Tx, review: NewReview, chainStatus: ChainStatus): Promise<string> {
    const reviewId = await this.openReview(tx, review);
    await this.writeOutcome(tx, {
      bankMessageId: review.bankMessageId,
      chainStatus,
      outcome: 'REVIEW',
      reviewId,
    });
    return reviewId;
  }

  /** Chain break: auto-credit stops on this card until the owner resumes it (fail-closed). */
  async pauseAutoCredit(tx: Tx, cardId: string): Promise<void> {
    await tx.topupCard.update({ where: { id: cardId }, data: { autoCreditPaused: true } });
  }

  /** VERIFYING -> ACTIVE: the owner's test transfer arrived at `verifiedAt`. */
  async activate(tx: Tx, cardId: string, verifiedAt: Date): Promise<void> {
    await this.moveCard(tx, cardId, 'VERIFYING', 'ACTIVE', { verifiedAt });
  }

  /** ACTIVE -> FULL: the limit is used up (docs/05 §2). */
  async markFull(tx: Tx, cardId: string): Promise<void> {
    await this.moveCard(tx, cardId, 'ACTIVE', 'FULL', {});
  }

  private async moveCard(
    tx: Tx,
    cardId: string,
    from: TopupCardStatus,
    to: TopupCardStatus,
    extra: { verifiedAt?: Date },
  ): Promise<void> {
    assertCardTransition(from, to);
    const { count } = await tx.topupCard.updateMany({
      where: { id: cardId, status: from },
      data: { status: to, ...extra },
    });
    if (count !== 1) throw new StaleCardError(cardId);
  }

  /**
   * The automatic credit (docs/05 §6 step 8), in the caller's card-locked transaction with the
   * intent row and the user's Wallet row already locked (CreditDecider): Payment(CONFIRMED) -> intent PAID ->
   * LedgerEntry(TOPUP, PAYMENT/<paymentId>) -> BankMessageOutcome(CREDITED). The money is the
   * message amount, which equals the intent amount (exact match, D-37 (4)). Any unique clash
   * (a second processor got here first) aborts the whole transaction.
   */
  async credit(
    tx: Tx,
    message: BankMessage,
    intent: IntentWithUser,
    chainStatus: ChainStatus,
    now: Date,
  ): Promise<string> {
    const amountTiyin = message.amountTiyin;
    const reservedUntil = intent.reservedUntil;
    if (amountTiyin === null || reservedUntil === null || amountTiyin !== intent.amountTiyin) {
      throw new Error(`intent ${intent.id} does not fit message ${message.id}`);
    }
    // paidAt is when the money arrived (Telegram's date), the time the grace is measured from.
    const paidAt = message.tgDate;
    assertIntentTransition(intent.status, 'PAID', {
      withinGrace: isWithinGrace(paidAt, reservedUntil),
      actor: 'system',
    });
    const payment = await tx.payment.create({
      data: {
        intentId: intent.id,
        userId: intent.userId,
        provider: 'P2P_CARD',
        providerTxnId: `${message.senderId.toString()}:${message.tgMessageId.toString()}`,
        amountTiyin,
        status: 'CONFIRMED',
        bankMessageId: message.id,
        confirmedAt: now,
        // Ids and codes only: never the text, the balance or a card number.
        raw: {
          source: message.source,
          tgMessageId: message.tgMessageId.toString(),
          parserVersion: message.parserVersion,
          chainStatus,
        },
      },
      select: { id: true },
    });
    const { count } = await tx.paymentIntent.updateMany({
      where: { id: intent.id, status: intent.status },
      data: {
        status: 'PAID',
        paidAt,
        reservedUntil: reservedUntilWhenPaid(
          { expiresAt: intent.expiresAt, reservedUntil },
          paidAt,
        ),
      },
    });
    if (count !== 1) throw new Error(`intent ${intent.id} changed while locked`);
    await appendLedgerEntry(tx, {
      userId: intent.userId,
      kind: 'TOPUP',
      amountTiyin,
      refType: 'PAYMENT',
      refId: payment.id,
    });
    await this.writeOutcome(tx, {
      bankMessageId: message.id,
      chainStatus,
      outcome: 'CREDITED',
      paymentId: payment.id,
    });
    return payment.id;
  }
}
