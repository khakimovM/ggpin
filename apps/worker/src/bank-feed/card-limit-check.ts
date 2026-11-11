import { Injectable } from '@nestjs/common';
import { NOTIFY_DEDUPE_SEC } from '@repo/shared';
import { BankFeedNotifier } from './bank-feed-notifier';
import { BankMessageRepository } from './bank-message.repository';
import { CardLimitsService } from './card-limits.service';

export type CardLimitResult = 'CHECKED' | 'NOT_APPLICABLE';

/**
 * The work of one `card-limit` job: reads the stored message and its outcome (ids and amounts
 * from the database, never from the job), runs the limit check under the card lock and raises
 * the limit alerts (`cardNearLimit`, `cardFull`, `lateOverLimit`). Safe to repeat: FULL is a
 * state and the alert ids are stable; alerts are added only while the outcome is younger than
 * NOTIFY_DEDUPE_SEC (the window the notify ids deduplicate in).
 */
@Injectable()
export class CardLimitCheck {
  constructor(
    private readonly reads: BankMessageRepository,
    private readonly limits: CardLimitsService,
    private readonly notifier: BankFeedNotifier,
  ) {}

  async run(bankMessageId: string, now: Date = new Date()): Promise<CardLimitResult> {
    const message = await this.reads.findForEffects(bankMessageId);
    const outcome = message?.outcome ?? null;
    if (
      message === null ||
      outcome === null ||
      message.parseStatus !== 'PARSED' ||
      message.direction !== 'CREDIT' ||
      message.cardId === null ||
      message.amountTiyin === null
    ) {
      return 'NOT_APPLICABLE';
    }
    const payment = outcome.outcome === 'CREDITED' ? outcome.payment : null;
    const paidAt = payment?.intent?.paidAt ?? null;
    const expiresAt = payment?.intent?.expiresAt ?? null;
    const alerts = await this.limits.afterReceived(
      {
        cardId: message.cardId,
        senderId: message.senderId,
        tgMessageId: message.tgMessageId,
        amountTiyin: message.amountTiyin,
        tgDate: message.tgDate,
        payment:
          payment === null || paidAt === null || expiresAt === null
            ? null
            : { id: payment.id, paidAt, expiresAt },
      },
      now,
    );
    if (now.getTime() - outcome.createdAt.getTime() >= NOTIFY_DEDUPE_SEC * 1000) return 'CHECKED';
    for (const { alert, refId } of alerts) await this.notifier.alert(alert, refId);
    return 'CHECKED';
  }

  /** Every attempt failed: the owner checks the card by hand (ids only, no database write). */
  giveUp(bankMessageId: string): Promise<void> {
    return this.notifier.alert('limitCheckFailed', bankMessageId);
  }
}
