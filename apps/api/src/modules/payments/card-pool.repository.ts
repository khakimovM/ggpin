import { Inject, Injectable } from '@nestjs/common';
import {
  cardTotals,
  lockTopupCard,
  type CardTotals,
  type CardTotalsQuery as DbCardTotalsQuery,
} from '@repo/db';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AmountUsage } from './amount-allocator';
import { CARD_LOCK_TIMING, type CardLockTiming } from './card-lock-timing';

export type { CardTotals } from '@repo/db';

/** The shared query (@repo/db) minus the capacity hold, which always comes from this API's config. */
export type CardTotalsQuery = Omit<DbCardTotalsQuery, 'holdSec'>;

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

  /**
   * The capacity sums (docs/05 §2): the ONE query shared with the worker (`cardTotals` in
   * @repo/db, D-42 (1)), with this API's TOPUP_CAPACITY_HOLD_SEC.
   */
  cardTotals(db: Db, query: CardTotalsQuery): Promise<CardTotals[]> {
    return cardTotals(db, { ...query, holdSec: this.config.TOPUP_CAPACITY_HOLD_SEC });
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
