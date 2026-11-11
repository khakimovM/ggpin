import { Inject, Injectable } from '@nestjs/common';
import { cardTotals, type Prisma } from '@repo/db';
import {
  RECONCILE_AUDIT,
  PURGE_OVERDUE_DAYS,
  tashkentMonthStart,
  type BankFeedSource,
} from '@repo/shared';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';

const P2P = 'P2P_CARD' as const;
/**
 * Rows of another chat (B2; ingest no longer stores them, but older rows may exist) carry ids of
 * that chat's numbering: never a re-scan start point, never "already known". Written as an OR
 * because `rejectReason <> 'FOREIGN_CHAT'` alone would also drop every NULL (accepted) row.
 */
const OWN_CHAT = {
  OR: [{ rejectReason: null }, { rejectReason: { not: 'FOREIGN_CHAT' } }],
} satisfies Prisma.BankMessageWhereInput;
/** How many example ids per finding the audit row keeps (the counts are always complete). */
export const EXAMPLE_IDS = 10;

const MESSAGE_SELECT = {
  id: true,
  cardId: true,
  tgMessageId: true,
  createdAt: true,
  parseStatus: true,
  direction: true,
  amountTiyin: true,
  balanceAfterTiyin: true,
  outcome: { select: { outcome: true, payment: { select: { amountTiyin: true } } } },
  reviews: { select: { kind: true, status: true } },
} satisfies Prisma.BankMessageSelect;

export type WindowMessage = Prisma.BankMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/**
 * Every read of the daily reconciliation (docs/05 §10) and its one write, the audit row. Plain
 * reads: nothing here takes a lock, moves money or changes a state.
 */
@Injectable()
export class ReconcileRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  /** Every stored message with Telegram date in the window, oldest first per card. */
  messagesSince(since: Date): Promise<WindowMessage[]> {
    return this.prisma.client.bankMessage.findMany({
      where: { tgDate: { gte: since } },
      orderBy: [{ cardId: 'asc' }, { tgMessageId: 'asc' }],
      select: MESSAGE_SELECT,
    });
  }

  /**
   * Stored messages still without a decision (BankMessageOutcome) and stored before
   * `settledBefore`, over ALL time, not just the window: a stuck message stays in every daily
   * report until it is decided. Any parse status: every stored message gets an outcome. This
   * also catches a job that died by BullMQ's stalled limit and never reached fail-closed.
   */
  async messagesWithoutOutcome(settledBefore: Date): Promise<Finding> {
    const where = { outcome: null, createdAt: { lt: settledBefore } };
    return finding(
      await this.prisma.client.bankMessage.count({ where }),
      await this.prisma.client.bankMessage.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: { id: true },
        take: EXAMPLE_IDS,
      }),
    );
  }

  /** The card's last PARSED message before `tgMessageId`: the first window message's link. */
  async previousParsed(cardId: string, tgMessageId: bigint) {
    return this.prisma.client.bankMessage.findFirst({
      where: { cardId, parseStatus: 'PARSED', tgMessageId: { lt: tgMessageId } },
      orderBy: { tgMessageId: 'desc' },
      select: { balanceAfterTiyin: true },
    });
  }

  /** The source's newest stored message older than the window: where the re-scan starts. */
  async lastIdBefore(source: BankFeedSource, since: Date): Promise<bigint | null> {
    const row = await this.prisma.client.bankMessage.findFirst({
      where: { source, tgDate: { lt: since }, ...OWN_CHAT },
      orderBy: { tgMessageId: 'desc' },
      select: { tgMessageId: true },
    });
    return row?.tgMessageId ?? null;
  }

  /** Which of these Telegram ids of the source are stored already (whoever sent them). */
  async knownIds(source: BankFeedSource, ids: readonly bigint[]): Promise<Set<bigint>> {
    const rows = await this.prisma.client.bankMessage.findMany({
      where: { source, tgMessageId: { in: [...ids] }, ...OWN_CHAT },
      select: { tgMessageId: true },
    });
    return new Set(rows.map((r) => r.tgMessageId));
  }

  async paymentsWithoutMessage(): Promise<Finding> {
    const where = { provider: P2P, bankMessageId: null };
    return finding(
      await this.prisma.client.payment.count({ where }),
      await this.prisma.client.payment.findMany({ where, select: { id: true }, take: EXAMPLE_IDS }),
    );
  }

  /** PENDING requests whose reservation (expiresAt + grace) already ended. */
  async pendingPastGrace(now: Date): Promise<Finding> {
    const where = { provider: P2P, status: 'PENDING', reservedUntil: { lte: now } } as const;
    return finding(
      await this.prisma.client.paymentIntent.count({ where }),
      await this.prisma.client.paymentIntent.findMany({
        where,
        select: { id: true },
        take: EXAMPLE_IDS,
      }),
    );
  }

  /** UNPAID requests whose grace window ended inside the reconciled window (information). */
  graceEnded(since: Date, now: Date): Promise<number> {
    return this.prisma.client.paymentIntent.count({
      where: {
        provider: P2P,
        status: { in: ['EXPIRED', 'CANCELLED'] },
        reservedUntil: { gte: since, lte: now },
      },
    });
  }

  /** Confirmed automatic payments of the window with their request times and card. */
  async paymentsSince(since: Date) {
    return this.prisma.client.payment.findMany({
      where: {
        provider: P2P,
        status: 'CONFIRMED',
        confirmedAt: { gte: since },
        intentId: { not: null },
      },
      select: {
        id: true,
        intent: { select: { expiresAt: true, paidAt: true } },
        bankMessage: { select: { cardId: true } },
      },
    });
  }

  /** Capacity sums of these live cards (the ONE shared query, this worker's hold). */
  liveCardTotals(cardIds: readonly string[], now: Date) {
    return Promise.all(
      cardIds.map(async (cardId) => {
        const [totals] = await cardTotals(this.prisma.client, {
          now,
          monthStart: tashkentMonthStart(now),
          statuses: ['ACTIVE', 'FULL', 'DRAINING'],
          autoCreditOnly: false,
          holdSec: this.config.TOPUP_CAPACITY_HOLD_SEC,
          cardId,
        });
        return totals;
      }),
    );
  }

  openReviews(): Promise<number> {
    return this.prisma.client.paymentReview.count({ where: { status: 'OPEN' } });
  }

  /** OPEN reviews opened before `before` (S9 I-1), the oldest first as examples. */
  async openReviewsOpenedBefore(before: Date): Promise<Finding> {
    const where = { status: 'OPEN', createdAt: { lt: before } } as const;
    return finding(
      await this.prisma.client.paymentReview.count({ where }),
      await this.prisma.client.paymentReview.findMany({
        where,
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: EXAMPLE_IDS,
      }),
    );
  }

  /**
   * Raw texts kept PURGE_OVERDUE_DAYS past their `purgeAfter` (the purge is failing or
   * behind); examples are BankMessage ids, the oldest first. The cut-off is the database clock in
   * UTC, as the purge and its trigger use it. Reads ids and a count only, never the text.
   */
  async purgeOverdue(): Promise<Finding> {
    const days = PURGE_OVERDUE_DAYS;
    const [counted] = await this.prisma.client.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "BankMessageText"
      WHERE "text" IS NOT NULL
        AND "purgeAfter" < timezone('UTC', now()) - make_interval(days => ${days}::int)`;
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT "bankMessageId" AS id FROM "BankMessageText"
      WHERE "text" IS NOT NULL
        AND "purgeAfter" < timezone('UTC', now()) - make_interval(days => ${days}::int)
      ORDER BY "purgeAfter", "bankMessageId"
      LIMIT ${EXAMPLE_IDS}::int`;
    return finding(counted?.n ?? 0, rows);
  }

  possibleReversalsSince(since: Date): Promise<number> {
    return this.prisma.client.paymentReview.count({
      where: { kind: 'POSSIBLE_REVERSAL', createdAt: { gte: since } },
    });
  }

  /** The run's audit row (actorType SYSTEM, no actor id, no ip): the reconcile alerts' source. */
  async writeAudit(day: string, after: Prisma.InputJsonObject): Promise<string> {
    const row = await this.prisma.client.auditLog.create({
      data: { ...RECONCILE_AUDIT, actorId: null, targetId: day, after },
      select: { id: true },
    });
    return row.id;
  }
}

/** A finding: the full count and up to EXAMPLE_IDS ids to start looking from. */
export interface Finding {
  readonly count: number;
  readonly ids: readonly string[];
}

function finding(count: number, rows: readonly { id: string }[]): Finding {
  return { count, ids: rows.map((r) => r.id) };
}
