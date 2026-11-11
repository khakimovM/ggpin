import { Injectable } from '@nestjs/common';
import {
  NOTIFY_DEDUPE_SEC,
  PaymentReviewKindSchema,
  reviewAlertOf,
  type BankFeedAlertKind,
} from '@repo/shared';
import { BankFeedNotifier } from './bank-feed-notifier';
import { BankMessageRepository, type ProcessedMessage } from './bank-message.repository';
import { CardLimitScheduler } from './card-limit-scheduler';
import { isLatePayment } from './match-rules';
import { WalletCacheInvalidator } from './wallet-cache-invalidator';

type Outcome = NonNullable<ProcessedMessage['outcome']>;

interface Alert {
  readonly alert: BankFeedAlertKind;
  readonly refId: string;
}

/**
 * What happens AFTER a message's decision committed, derived from its stored outcome every time
 * (first run and replays alike), in this order:
 * 1. the cached balance is dropped and the user is told (CREDITED);
 * 2. the owner alerts of the decision (review, DEBIT, card verified) are queued;
 * 3. the card-limit check is handed to its own `card-limit` job (every PARSED CREDIT on a card).
 * So nothing the limit check does (a busy card, an error) can hold back or lose 1 and 2 (M-1);
 * the limit alerts come from that job. Each step is idempotent (DEL, job ids), so a retry after
 * a crash between the commit and these steps completes them without doubling any. Never before
 * the commit: a rolled-back credit must not tell anybody anything.
 *
 * Notifications are added only while the outcome is younger than NOTIFY_DEDUPE_SEC: inside that
 * window the retained notify job id drops a repeat, after it a replay is not news, so a user is
 * never told "wallet topped up" twice and the owner never gets the same alert twice.
 */
@Injectable()
export class BankFeedEffects {
  constructor(
    private readonly reads: BankMessageRepository,
    private readonly notifier: BankFeedNotifier,
    private readonly walletCache: WalletCacheInvalidator,
    private readonly limitChecks: CardLimitScheduler,
  ) {}

  async run(bankMessageId: string, now: Date = new Date()): Promise<void> {
    const message = await this.reads.findForEffects(bankMessageId);
    const outcome = message?.outcome ?? null;
    if (message === null || outcome === null) return;
    const notify = now.getTime() - outcome.createdAt.getTime() < NOTIFY_DEDUPE_SEC * 1000;
    await this.credited(message, outcome, notify);
    if (notify) {
      for (const { alert, refId } of alertsOf(message, outcome)) {
        await this.notifier.alert(alert, refId);
      }
    }
    // D-45: every received CREDIT counts toward the card's limits, credited or not.
    if (
      message.parseStatus === 'PARSED' &&
      message.direction === 'CREDIT' &&
      message.cardId !== null
    ) {
      await this.limitChecks.schedule(message.id);
    }
  }

  /** CREDITED: drop the cached balance and tell the user. */
  private async credited(message: ProcessedMessage, outcome: Outcome, notify: boolean) {
    const payment = outcome.payment;
    if (outcome.outcome !== 'CREDITED' || payment === null) return;
    const intent = payment.intent;
    const paidAt = intent?.paidAt ?? null;
    if (intent === null || paidAt === null || message.cardId === null) {
      throw new Error(`credited message ${message.id} has no paid intent`);
    }
    await this.walletCache.invalidate(payment.userId);
    if (notify) await this.notifier.topupCredited(payment.id, isLatePayment(intent, paidAt));
  }
}

/** The owner alerts of a decision itself (the limit alerts come from the card-limit job). */
function alertsOf(message: ProcessedMessage, outcome: Outcome): Alert[] {
  const alerts: Alert[] = [];
  // Every DEBIT on a receiving card is reported, whatever else happened (D-37 (8)).
  if (
    message.parseStatus === 'PARSED' &&
    message.cardId !== null &&
    message.direction === 'DEBIT'
  ) {
    alerts.push({ alert: 'debit', refId: message.id });
  }
  if (outcome.outcome === 'REVIEW' && outcome.review !== null) {
    const kind = PaymentReviewKindSchema.parse(outcome.review.kind);
    const alert = reviewAlertOf(kind, outcome.review.note, message.cardId !== null);
    alerts.push({ alert, refId: outcome.review.id });
  }
  if (outcome.outcome === 'CARD_VERIFIED' && message.cardId !== null) {
    alerts.push({ alert: 'cardVerified', refId: message.cardId });
  }
  return alerts;
}
