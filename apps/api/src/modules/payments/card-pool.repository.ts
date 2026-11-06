import { Inject, Injectable } from '@nestjs/common';
import {
  lockTopupCard,
  type CardBank,
  type Prisma,
  type TopupCard,
  type TopupCardStatus,
} from '@repo/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AmountUsage } from './amount-allocator';
import { CARD_LOCK_TIMING, type CardLockTiming } from './card-lock-timing';

/** A card with the three sums its free capacity is computed from (docs/05 §2). */
export interface CardTotals {
  readonly card: TopupCard;
  /** Every PARSED CREDIT on the card since `verifiedAt`, matched or not (the bank's view). */
  readonly receivedTiyin: bigint;
  /** The same, since the start of the current month (Asia/Tashkent). */
  readonly receivedMonthTiyin: bigint;
  /** UNPAID amounts still counted (`reservedUntil > now`, `expiresAt > now - hold`): money that may still arrive. */
  readonly reservedTiyin: bigint;
}

export interface CardTotalsQuery {
  readonly now: Date;
  readonly monthStart: Date;
  readonly statuses: readonly TopupCardStatus[];
  /** Only cards whose auto-credit is on (the allocator); the admin services want every card. */
  readonly autoCreditOnly: boolean;
  readonly bank?: CardBank;
  readonly cardId?: string;
}

function sumOf(value: bigint | null | undefined): bigint {
  return value ?? 0n;
}

@Injectable()
export class CardPoolRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CARD_LOCK_TIMING) private readonly timing: CardLockTiming,
  ) {}

  get client(): Db {
    return this.prisma.client;
  }

  /**
   * Runs `fn` in its own transaction (waits: card-lock-timing.ts). The whole-transaction timeout
   * is wider than Prisma's default 5 s: requests for one card queue on its advisory lock inside
   * the transaction, by design; `maxWait` stays under pg's pool timeout.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn, {
      maxWait: this.timing.maxWaitMs,
      timeout: this.timing.timeoutMs,
    });
  }

  /**
   * Serialises every writer of this card's amounts and status until `tx` ends. ONE card lock
   * per transaction (docs/05 §3): nobody ever holds two, so lock order cannot deadlock. The SQL
   * lives in @repo/db (`lockTopupCard`), shared with the worker.
   */
  lockCard(tx: Db, cardId: string): Promise<void> {
    return lockTopupCard(tx, cardId);
  }

  /**
   * A request waits for a card lock at most `lockWaitMs` (S4-05): a busy card answers 55P03 and
   * the allocator moves on to the next card, instead of holding a pooled connection until the
   * transaction times out. `set_config(..., true)` is `SET LOCAL` with a bound value: it ends
   * with the transaction. The owner CLI does not set it (it may wait).
   */
  async boundLockWait(tx: Db): Promise<void> {
    const wait = `${String(this.timing.lockWaitMs)}ms`;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${wait}, true) AS "lockTimeout"`;
  }

  private holdMs(): number {
    return this.config.TOPUP_CAPACITY_HOLD_SEC * 1000;
  }

  async cardTotals(db: Db, query: CardTotalsQuery): Promise<CardTotals[]> {
    const cards = await db.topupCard.findMany({
      where: {
        status: { in: [...query.statuses] },
        ...(query.autoCreditOnly ? { autoCreditPaused: false } : {}),
        ...(query.bank === undefined ? {} : { bank: query.bank }),
        ...(query.cardId === undefined ? {} : { id: query.cardId }),
      },
      orderBy: { id: 'asc' },
    });
    if (cards.length === 0) return [];
    const ids = cards.map((card) => card.id);
    const credit = { parseStatus: 'PARSED', direction: 'CREDIT' } as const;
    // A card that was never verified has received nothing that counts (VERIFYING has no
    // verifiedAt; the verification transfer itself counts from verifiedAt on).
    const since = (card: TopupCard, from?: Date): Prisma.BankMessageWhereInput => {
      const verifiedAt = card.verifiedAt ?? query.now;
      const start = from !== undefined && from > verifiedAt ? from : verifiedAt;
      return { cardId: card.id, tgDate: { gte: start } };
    };
    const [received, receivedMonth, reserved] = await Promise.all([
      db.bankMessage.groupBy({
        by: ['cardId'],
        where: { ...credit, OR: cards.map((card) => since(card)) },
        _sum: { amountTiyin: true },
      }),
      db.bankMessage.groupBy({
        by: ['cardId'],
        where: { ...credit, OR: cards.map((card) => since(card, query.monthStart)) },
        _sum: { amountTiyin: true },
      }),
      // Unpaid money that may still arrive (D-42 (1); the SQL form of `capacityHoldEnd`): every
      // UNPAID request (PENDING, EXPIRED, CANCELLED) until LEAST(reservedUntil, expiresAt +
      // TOPUP_CAPACITY_HOLD_SEC). One predicate for all three, so an overdue PENDING the sweep
      // has not expired yet stops counting at the same moment an EXPIRED one would, and
      // create-and-cancel cannot fill a card for a day. The AMOUNT stays unique for the whole
      // grace (amountUsage reads reservedUntil only).
      // PAID amounts are not "reserved": their money is already in `received` (the payment's
      // bank message); counting it twice would make a card look full too early.
      // Known overcount, on the safe side (m10): money that arrived for a CANCELLED request and
      // still waits in review is in `received` AND, inside the hold window, here as well.
      db.paymentIntent.groupBy({
        by: ['cardId'],
        where: {
          cardId: { in: ids },
          provider: 'P2P_CARD',
          status: { in: ['PENDING', 'EXPIRED', 'CANCELLED'] },
          reservedUntil: { gt: query.now },
          expiresAt: { gt: new Date(query.now.getTime() - this.holdMs()) },
        },
        _sum: { amountTiyin: true },
      }),
    ]);
    const byCard = (rows: { cardId: string | null; _sum: { amountTiyin: bigint | null } }[]) =>
      new Map(rows.map((row) => [row.cardId, sumOf(row._sum.amountTiyin)]));
    const receivedBy = byCard(received);
    const monthBy = byCard(receivedMonth);
    const reservedBy = byCard(reserved);
    return cards.map((card) => ({
      card,
      receivedTiyin: receivedBy.get(card.id) ?? 0n,
      receivedMonthTiyin: monthBy.get(card.id) ?? 0n,
      reservedTiyin: reservedBy.get(card.id) ?? 0n,
    }));
  }

  /** Amounts in [from, to] held on the card at any time after `since`, with their last end. */
  async amountUsage(
    tx: Db,
    cardId: string,
    range: { readonly from: bigint; readonly to: bigint; readonly since: Date },
  ): Promise<AmountUsage[]> {
    const rows = await tx.paymentIntent.groupBy({
      by: ['amountTiyin'],
      where: {
        cardId,
        provider: 'P2P_CARD',
        amountTiyin: { gte: range.from, lte: range.to },
        reservedUntil: { gt: range.since },
      },
      _max: { reservedUntil: true },
    });
    return rows.flatMap((row) =>
      row._max.reservedUntil === null
        ? []
        : [{ amountTiyin: row.amountTiyin, lastReservedUntil: row._max.reservedUntil }],
    );
  }

  /** The card of the user's latest P2P request (the "sticky" card, D-37 (3)), if any. */
  async lastCardIdOf(userId: string): Promise<string | null> {
    const row = await this.prisma.client.paymentIntent.findFirst({
      where: { userId, provider: 'P2P_CARD' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { cardId: true },
    });
    return row?.cardId ?? null;
  }
}
