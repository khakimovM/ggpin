import { Inject, Injectable } from '@nestjs/common';
import { cardTotals, lockTopupCard, lockWallet, usedTopupBaseSince, type Tx } from '@repo/db';
import { tashkentMonthStart } from '@repo/shared';
import type { ReceivedBefore } from './card-limit-rules';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';

const LIVE_STATUSES = ['ACTIVE', 'FULL', 'DRAINING'] as const;

/**
 * The shared @repo/db queries the matcher and the card-limit check use, behind one repository
 * (rules/10: services do not touch Prisma helpers directly). The lock order of every worker
 * transaction is: lock wait set -> card advisory lock (ONE per transaction, the API's key) ->
 * intent row FOR UPDATE -> Wallet row.
 */
@Injectable()
export class TopupCardsRepository {
  constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {}

  /**
   * `lock_timeout` for the rest of this transaction (`is_local = true`), a bound parameter like
   * the API's allocator: a card held elsewhere fails this attempt with 55P03 and the job retries
   * with its backoff instead of hanging until the transaction timeout.
   */
  async setLockTimeout(
    tx: Tx,
    waitMs: number = this.config.BANK_FEED_LOCK_TIMEOUT_MS,
  ): Promise<void> {
    const wait = `${String(waitMs)}ms`;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${wait}, true) AS "lockTimeout"`;
  }

  /**
   * Options of an interactive transaction that waits on a card lock (setLockTimeout): Prisma's
   * default 5 s timeout must not end the transaction before `lock_timeout` does, or a busy card
   * shows up as a transaction timeout instead of 55P03. maxWait as the matcher's TX_OPTIONS.
   */
  cardLockTxOptions(): { readonly maxWait: number; readonly timeout: number } {
    return { maxWait: 4_000, timeout: this.config.BANK_FEED_LOCK_TIMEOUT_MS + 5_000 };
  }

  /** The card's advisory lock, the same key as the API (`lockTopupCard`). */
  lockCard(tx: Tx, cardId: string): Promise<void> {
    return lockTopupCard(tx, cardId);
  }

  /** The user's Wallet row FOR UPDATE: daily-cap check and credit of one user are serialised. */
  lockWallet(tx: Tx, userId: string): Promise<void> {
    return lockWallet(tx, userId);
  }

  /** Base amounts the user's other requests use in the 24 h window (the API's formula). */
  usedBaseSince(tx: Tx, userId: string, since: Date, exceptIntentId: string): Promise<bigint> {
    return usedTopupBaseSince(tx, userId, since, exceptIntentId);
  }

  /** The card's capacity sums (the ONE shared query, D-42 (1)); undefined when not live. */
  async totals(tx: Tx, cardId: string, now: Date) {
    const [totals] = await cardTotals(tx, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: LIVE_STATUSES,
      autoCreditOnly: false,
      holdSec: this.config.TOPUP_CAPACITY_HOLD_SEC,
      cardId,
    });
    return totals;
  }

  /** Capacity sums of every ACTIVE card (the sweep's 80 % / FULL backstop); an unlocked read. */
  activeTotals(db: Tx, now: Date) {
    return cardTotals(db, {
      now,
      monthStart: tashkentMonthStart(now),
      statuses: ['ACTIVE'],
      autoCreditOnly: false,
      holdSec: this.config.TOPUP_CAPACITY_HOLD_SEC,
    });
  }

  /**
   * Money the card received BEFORE this message: PARSED CREDITs of the same card and bot with a
   * lower tgMessageId (the bot's own order), in the windows cardTotals uses (from verifiedAt;
   * the month also from monthStart). Zero for a card never verified.
   */
  async receivedBefore(
    tx: Tx,
    message: { cardId: string; senderId: bigint; tgMessageId: bigint },
    verifiedAt: Date | null,
    monthStart: Date,
  ): Promise<ReceivedBefore> {
    if (verifiedAt === null) return { receivedTiyin: 0n, receivedMonthTiyin: 0n };
    const where = {
      cardId: message.cardId,
      senderId: message.senderId,
      tgMessageId: { lt: message.tgMessageId },
      parseStatus: 'PARSED',
      direction: 'CREDIT',
    } as const;
    const monthFrom = monthStart > verifiedAt ? monthStart : verifiedAt;
    const [all, month] = await Promise.all([
      tx.bankMessage.aggregate({
        where: { ...where, tgDate: { gte: verifiedAt } },
        _sum: { amountTiyin: true },
      }),
      tx.bankMessage.aggregate({
        where: { ...where, tgDate: { gte: monthFrom } },
        _sum: { amountTiyin: true },
      }),
    ]);
    return {
      receivedTiyin: all._sum.amountTiyin ?? 0n,
      receivedMonthTiyin: month._sum.amountTiyin ?? 0n,
    };
  }
}
