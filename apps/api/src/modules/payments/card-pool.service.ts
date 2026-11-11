import { Inject, Injectable } from '@nestjs/common';
import type { CardBank } from '@repo/db';
import { CARD_BANKS, reservedUntilAtCreation } from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import {
  AMOUNT_RANDOM,
  RECENT_AMOUNT_WINDOW_MS,
  SOM_TIYIN,
  allocateAmount,
  type AmountRandom,
} from './amount-allocator';
import { freeCapacity, rankCards, tashkentMonthStart } from './card-capacity';
import { CardPoolRepository } from './card-pool.repository';
import { intentInsertConflict, isDatabaseBusy, isLockNotAvailable } from './db-errors';
import { intentExpiresAt } from './intent-times';
import { TopupIntentsRepository, type IntentWithCard } from './topup-intents.repository';

/** The INSERT lost a race the service answers itself (409 pending / idempotent replay). */
export class IntentInsertRace extends Error {
  constructor(readonly conflict: 'USER_PENDING' | 'IDEMPOTENCY_KEY') {
    super(`intent insert lost a race: ${conflict}`);
    this.name = 'IntentInsertRace';
  }
}

export interface AllocationRequest {
  readonly userId: string;
  readonly baseTiyin: bigint;
  readonly bank?: CardBank;
  readonly now: Date;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** HMAC of the new pay token for the id the database assigns. */
  readonly hashFor: (intentId: string) => string;
}

const unavailable = (): AppError => new AppError('PAYMENT_METHOD_UNAVAILABLE');

/**
 * Card choice and unique-amount allocation (docs/05 §3). Every attempt is one transaction that
 * holds ONE card's advisory lock: re-check the card (still ACTIVE, not paused, room for the
 * request), read the amounts held near the base, pick one, insert. A card with no free amount is
 * skipped for the next one, each in its own transaction (never two locks at once). A lost
 * amount race (P2002 on the pending unique or 23P01 on the reservation EXCLUDE) is retried
 * once; a second loss is 503, not a loop.
 */
@Injectable()
export class CardPoolService {
  constructor(
    private readonly repo: CardPoolRepository,
    private readonly intents: TopupIntentsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AMOUNT_RANDOM) private readonly random: AmountRandom,
  ) {}

  /** The worst-case pay amount of a request: base plus the largest suffix. */
  needFor(baseTiyin: bigint): bigint {
    return baseTiyin + BigInt(this.config.TOPUP_SUFFIX_MAX_SOM) * SOM_TIYIN;
  }

  /** Per bank: is there a card that can take the smallest request right now? */
  async availability(now: Date): Promise<Record<CardBank, boolean>> {
    const cards = await this.usableCards(this.repo.client, now);
    const need = this.needFor(this.config.TOPUP_MIN_TIYIN);
    const result: Record<CardBank, boolean> = { HUMO: false, UZCARD: false };
    for (const bank of CARD_BANKS) {
      result[bank] = cards.some(
        (totals) => totals.card.bank === bank && freeCapacity(totals) >= need,
      );
    }
    return result;
  }

  async allocate(request: AllocationRequest): Promise<IntentWithCard> {
    const need = this.needFor(request.baseTiyin);
    const ranked = rankCards(
      await this.usableCards(this.repo.client, request.now, request.bank),
      need,
      await this.repo.lastCardIdOf(request.userId),
    );
    let raceRetries = 1;
    for (const candidate of ranked) {
      for (;;) {
        try {
          const created = await this.repo.transaction((tx) =>
            this.tryCard(tx, candidate.card.id, request, need),
          );
          if (created !== null) return created;
          break; // no room or no free amount on this card any more: next card
        } catch (error) {
          // 55P03: mostly a busy card (its lock not had within lockWaitMs), sometimes the INSERT
          // waiting for a twin request's row. Either way nothing was written and we hold no lock
          // any more (the transaction ended with the error), so the next card is safe; a twin
          // that commits meanwhile surfaces there as a conflict. A busy DATABASE (pool or
          // transaction timeout) is overload, not a bug: 503 at once (S4-05).
          if (isLockNotAvailable(error)) break;
          if (isDatabaseBusy(error)) throw unavailable();
          const conflict = intentInsertConflict(error);
          if (conflict === 'AMOUNT_TAKEN') {
            if (raceRetries === 0) throw unavailable();
            raceRetries -= 1;
            continue;
          }
          if (conflict !== null) throw new IntentInsertRace(conflict);
          throw error;
        }
      }
    }
    throw unavailable();
  }

  private usableCards(db: Db, now: Date, bank?: CardBank) {
    return this.repo.cardTotals(db, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: ['ACTIVE'],
      autoCreditOnly: true,
      ...(bank === undefined ? {} : { bank }),
    });
  }

  private async tryCard(
    tx: Db,
    cardId: string,
    request: AllocationRequest,
    need: bigint,
  ): Promise<IntentWithCard | null> {
    await this.repo.boundLockWait(tx);
    await this.repo.lockCard(tx, cardId);
    // Re-read under the lock: retire/pause/limit changes and other allocations take it too.
    const [totals] = await this.repo.cardTotals(tx, {
      now: request.now,
      monthStart: tashkentMonthStart(request.now),
      statuses: ['ACTIVE'],
      autoCreditOnly: true,
      cardId,
    });
    if (totals === undefined || freeCapacity(totals) < need) return null;

    const suffixMaxSom = this.config.TOPUP_SUFFIX_MAX_SOM;
    const usage = await this.repo.amountUsage(tx, cardId, {
      from: request.baseTiyin + SOM_TIYIN,
      to: request.baseTiyin + BigInt(suffixMaxSom) * SOM_TIYIN,
      since: new Date(request.now.getTime() - RECENT_AMOUNT_WINDOW_MS),
    });
    const amountTiyin = allocateAmount({
      baseTiyin: request.baseTiyin,
      suffixMaxSom,
      usage,
      now: request.now,
      random: this.random,
    });
    if (amountTiyin === null) return null;

    const expiresAt = intentExpiresAt(request.now, this.config.TOPUP_INTENT_TTL_SEC);
    return this.intents.insert(
      tx,
      {
        userId: request.userId,
        cardId,
        baseAmountTiyin: request.baseTiyin,
        amountTiyin,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        createdAt: request.now,
        expiresAt,
        reservedUntil: reservedUntilAtCreation(expiresAt, this.config.TOPUP_LATE_GRACE_SEC),
      },
      request.hashFor,
    );
  }
}
