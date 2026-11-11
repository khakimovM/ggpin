import { Inject, Injectable } from '@nestjs/common';
import {
  CARD_FULL_PERCENT,
  cardLimitAlertRef,
  isOverReceiveLimit,
  receivedUsagePercent,
  tashkentMonthStart,
  type BankFeedAlertKind,
} from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import { limitCrossing, sumsAfter, type ReceivedCredit } from './card-limit-rules';
import { isPastCapacityHold } from './match-rules';
import { MatchWritesRepository } from './match-writes.repository';
import { TopupCardsRepository } from './topup-cards.repository';

export interface LimitAlert {
  readonly alert: BankFeedAlertKind;
  readonly refId: string;
}

/** A PARSED CREDIT on a card, and its payment when it was credited automatically. */
export interface ReceivedOnCard extends ReceivedCredit {
  readonly cardId: string;
  /** The message's place in its bot's chat: "before" is every earlier CREDIT of the card. */
  readonly senderId: bigint;
  readonly tgMessageId: bigint;
  readonly payment: {
    readonly id: string;
    readonly paidAt: Date;
    readonly expiresAt: Date;
  } | null;
}

/**
 * The card-limit check after a CREDIT message's decision committed (docs/05 §2, §6 step 8), run
 * by the `card-limit` job (CardLimitCheck), never inside the message's own effects:
 * for EVERY parsed CREDIT on a card (credited, reviewed or the verification transfer), because
 * the bank counts all received money (D-45). One transaction under the card's advisory lock (the
 * API's key, the only card lock held), so ACTIVE -> FULL never races the API's allocation or
 * card commands. The sums come from the ONE shared query (`cardTotals`) with this worker's
 * TOPUP_CAPACITY_HOLD_SEC, equal to the API's (D-42 (1)); held UNPAID amounts never change the
 * card's state.
 *
 * Alerts, without repeats (L7): `cardFull` when this check moved the card ACTIVE -> FULL, or
 * when the card is FULL and this credit is the one that crossed 100 % (the replay of a check
 * whose alert was lost after the commit); `cardNearLimit` only when this credit crossed 80 %.
 * Both are computed statelessly from the money received BEFORE this message (by tgMessageId) and
 * that plus this credit, so a late replay of an older message is judged as it was. Their refIds
 * carry the card's limits, so after `card:limit` the card filling up again is announced again.
 * `lateOverLimit` stays for automatic credits only.
 */
@Injectable()
export class CardLimitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: TopupCardsRepository,
    private readonly writes: MatchWritesRepository,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  afterReceived(credit: ReceivedOnCard, now: Date = new Date()): Promise<LimitAlert[]> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.cards.setLockTimeout(tx);
      await this.cards.lockCard(tx, credit.cardId);
      const totals = await this.cards.totals(tx, credit.cardId, now);
      if (totals === undefined) return [];
      const alerts: LimitAlert[] = [];
      // The card's state follows ALL money received now; the alert follows THIS credit.
      const after = receivedUsagePercent(totals);
      const monthStart = tashkentMonthStart(now);
      const earlier = await this.cards.receivedBefore(
        tx,
        credit,
        totals.card.verifiedAt,
        monthStart,
      );
      const crossing = limitCrossing(
        receivedUsagePercent({ ...totals, ...earlier }),
        receivedUsagePercent(sumsAfter(totals.card, earlier, credit, monthStart)),
      );
      const limits = {
        cardId: credit.cardId,
        receiveLimitTiyin: totals.card.receiveLimitTiyin,
        monthlyLimitTiyin: totals.card.monthlyLimitTiyin,
      };
      if (after >= CARD_FULL_PERCENT) {
        const moved = totals.card.status === 'ACTIVE';
        if (moved) await this.writes.markFull(tx, credit.cardId);
        if (moved || (totals.card.status === 'FULL' && crossing === 'FULL')) {
          alerts.push({ alert: 'cardFull', refId: cardLimitAlertRef('cardFull', limits) });
        }
      } else if (crossing === 'NEAR') {
        alerts.push({
          alert: 'cardNearLimit',
          refId: cardLimitAlertRef('cardNearLimit', limits),
        });
      }
      // D-42 residual risk: the share of a request whose hold had ended was handed out again, so
      // its late money may have pushed the card past what the bank allows.
      const payment = credit.payment;
      if (
        payment !== null &&
        isPastCapacityHold(payment, payment.paidAt, this.config.TOPUP_CAPACITY_HOLD_SEC) &&
        isOverReceiveLimit(totals)
      ) {
        alerts.push({ alert: 'lateOverLimit', refId: payment.id });
      }
      return alerts;
    }, this.cards.cardLockTxOptions());
  }
}
