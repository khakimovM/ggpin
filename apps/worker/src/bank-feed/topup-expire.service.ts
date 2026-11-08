import { Injectable, Logger } from '@nestjs/common';
import { expireOverdueTopups, type CardTotals } from '@repo/db';
import {
  CARD_FULL_PERCENT,
  CARD_NEAR_LIMIT_PERCENT,
  assertIntentTransition,
  cardLimitAlertRef,
  receivedUsagePercent,
} from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';
import { BankFeedNotifier } from './bank-feed-notifier';
import { MatchWritesRepository } from './match-writes.repository';
import { OrphanRequeueService } from './orphan-requeue.service';
import { TopupCardsRepository } from './topup-cards.repository';

export interface TopupExpireResult {
  readonly expired: number;
  /** ACTIVE cards this sweep moved to FULL. */
  readonly madeFull: number;
  /** Cards whose limit alert (near 80 % or full) was handed to the notify queue. */
  readonly limitAlerts: number;
  /** Cards that could not be checked this time (busy, or an error): the next sweep retries. */
  readonly skippedCards: number;
  /** Bank messages without a decision whose job was added again or retried (S9 m1). */
  readonly requeuedMessages: number;
}

const SYSTEM = { actor: 'system', withinGrace: true } as const;

/**
 * The every-minute `topup-expire` sweep (docs/05 §10):
 * 1. PENDING -> EXPIRED for every request past `expiresAt`, with the API's own predicate
 *    (`expireOverdueTopups`, @repo/db) after `assertIntentTransition`. PAID, CANCELLED and
 *    EXPIRED rows are never touched and the amount stays reserved through its grace window.
 * 2. The backstop of the per-message card-limit job (D-45, money RECEIVED only): an ACTIVE card
 *    at 100 % becomes FULL under its card lock (one lock per transaction, the API's key) and the
 *    owner gets `cardFull`; one at 80-99 % gets `cardNearLimit`. The alert ids are the same
 *    `cardLimitAlertRef` the card-limit job uses, so the notify queue keeps one alert per card
 *    and limit set; an alert repeats only after NOTIFY_DEDUPE_SEC (30 days) while the card stays
 *    there, a deliberate reminder.
 * 3. The orphan fallback (OrphanRequeueService): a stored message with no decision and no live
 *    job gets its `bm-<id>` job back. Its own failure does not stop the steps above.
 * The sweep moves no money. Logs carry counts and card ids only.
 */
@Injectable()
export class TopupExpireService {
  private readonly logger = new Logger(TopupExpireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: TopupCardsRepository,
    private readonly writes: MatchWritesRepository,
    private readonly notifier: BankFeedNotifier,
    private readonly orphans: OrphanRequeueService,
  ) {}

  async run(now: Date = new Date()): Promise<TopupExpireResult> {
    assertIntentTransition('PENDING', 'EXPIRED', SYSTEM);
    const expired = await expireOverdueTopups(this.prisma.client, now);
    let madeFull = 0;
    let limitAlerts = 0;
    let skippedCards = 0;
    for (const totals of await this.cards.activeTotals(this.prisma.client, now)) {
      try {
        const verdict = await this.checkCard(totals, now);
        if (verdict === 'MADE_FULL') madeFull += 1;
        if (verdict !== 'BELOW') limitAlerts += 1;
      } catch (error) {
        skippedCards += 1;
        const name = error instanceof Error ? error.name : 'unknown';
        this.logger.warn(`topup-expire card=${totals.card.id} not checked: ${name}`);
      }
    }
    const requeuedMessages = await this.requeueOrphans(now);
    return { expired, madeFull, limitAlerts, skippedCards, requeuedMessages };
  }

  private async requeueOrphans(now: Date): Promise<number> {
    try {
      const { added, retried } = await this.orphans.run(now);
      return added + retried;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(`topup-expire orphan re-queue failed: ${name}`);
      return 0;
    }
  }

  private async checkCard(
    totals: CardTotals,
    now: Date,
  ): Promise<'BELOW' | 'NEAR' | 'MADE_FULL' | 'FULL'> {
    const percent = receivedUsagePercent(totals);
    if (percent < CARD_NEAR_LIMIT_PERCENT) return 'BELOW';
    const cardId = totals.card.id;
    if (percent < CARD_FULL_PERCENT) {
      await this.notifier.alert(
        'cardNearLimit',
        cardLimitAlertRef('cardNearLimit', limitsOf(totals)),
      );
      return 'NEAR';
    }
    // Re-read under the card lock: ACTIVE -> FULL must not race the allocator or a card command.
    const locked = await this.prisma.client.$transaction(async (tx) => {
      await this.cards.setLockTimeout(tx);
      await this.cards.lockCard(tx, cardId);
      const fresh = await this.cards.totals(tx, cardId, now);
      if (fresh === undefined || receivedUsagePercent(fresh) < CARD_FULL_PERCENT) return null;
      const moved = fresh.card.status === 'ACTIVE';
      if (moved) await this.writes.markFull(tx, cardId);
      return { fresh, moved };
    });
    if (locked === null) return 'BELOW';
    await this.notifier.alert('cardFull', cardLimitAlertRef('cardFull', limitsOf(locked.fresh)));
    return locked.moved ? 'MADE_FULL' : 'FULL';
  }
}

function limitsOf(totals: CardTotals) {
  return {
    cardId: totals.card.id,
    receiveLimitTiyin: totals.card.receiveLimitTiyin,
    monthlyLimitTiyin: totals.card.monthlyLimitTiyin,
  };
}
