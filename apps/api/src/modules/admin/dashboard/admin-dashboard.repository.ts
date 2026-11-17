import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { CARD_BANKS } from '@repo/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import type { TopupTotals } from './admin-dashboard-figures';
import type { DashboardPeriod } from './admin-dashboard-period';

/** Final states the delivery rate is measured against (docs/04 «Dashboard»). */
export const FINAL_ORDER_STATES = ['DELIVERED', 'FAILED', 'REFUNDED', 'CANCELLED'] as const;

/** Only what the profit formula and the charts need (narrow rows, read in keyset batches). */
const DELIVERED_SELECT = {
  id: true,
  priceTiyin: true,
  discountTiyin: true,
  costCurrency: true,
  costMinor: true,
  createdAt: true,
  deliveredAt: true,
  productId: true,
  fxRate: { select: { pair: true, rate: true } },
} as const satisfies Prisma.OrderSelect;
export type DeliveredOrderSource = Prisma.OrderGetPayload<{ select: typeof DELIVERED_SELECT }>;

export interface DeliveredCursor {
  readonly deliveredAt: Date;
  readonly id: string;
}

const range = (period: DashboardPeriod) => ({ gte: period.from, lt: period.to });

// The dashboard's reads (all users: the panel is the owner's view of the whole shop). Sums and
// counts are done by the database; the per-order profit is not (it needs money-pricing.ts), so
// those rows come in bounded keyset batches. Indexes `Order(status, deliveredAt)` and
// `Payment(status, confirmedAt)` arrive with the 9-B migration.
@Injectable()
export class AdminDashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  /**
   * One batch of the orders delivered in the period and still DELIVERED (a refunded one has left
   * that state), oldest first, strictly after `cursor`.
   */
  deliveredBatch(
    period: DashboardPeriod,
    cursor: DeliveredCursor | null,
    take: number,
  ): Promise<DeliveredOrderSource[]> {
    const after: Prisma.OrderWhereInput =
      cursor === null
        ? {}
        : {
            OR: [
              { deliveredAt: { gt: cursor.deliveredAt } },
              { deliveredAt: cursor.deliveredAt, id: { gt: cursor.id } },
            ],
          };
    return this.db.order.findMany({
      where: { AND: [{ status: 'DELIVERED', deliveredAt: range(period) }, after] },
      select: DELIVERED_SELECT,
      orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  async productNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.product.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, nameUz: true },
    });
    return new Map(rows.map((row) => [row.id, row.nameUz]));
  }

  ordersCreated(period: DashboardPeriod): Promise<number> {
    return this.db.order.count({ where: { createdAt: range(period) } });
  }

  /** Orders created in the period that have reached a final state, per state. */
  async finalStates(period: DashboardPeriod) {
    const rows = await this.db.order.groupBy({
      by: ['status'],
      where: { createdAt: range(period), status: { in: [...FINAL_ORDER_STATES] } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }

  newUsers(period: DashboardPeriod): Promise<number> {
    return this.db.user.count({ where: { createdAt: range(period) } });
  }

  /** Confirmed top-ups of the period: the total and one aggregate per bank of the card reached. */
  async topupTotals(period: DashboardPeriod): Promise<TopupTotals> {
    const where = { status: 'CONFIRMED', confirmedAt: range(period) } as const;
    const [total, ...banks] = await Promise.all([
      this.db.payment.aggregate({ where, _sum: { amountTiyin: true }, _count: { _all: true } }),
      ...CARD_BANKS.map((bank) =>
        this.db.payment.aggregate({
          where: { ...where, bankMessage: { card: { bank } } },
          _sum: { amountTiyin: true },
          _count: { _all: true },
        }),
      ),
    ]);
    return {
      amountTiyin: total._sum.amountTiyin ?? 0n,
      count: total._count._all,
      byBank: CARD_BANKS.map((bank, i) => ({
        bank,
        amountTiyin: banks[i]?._sum.amountTiyin ?? 0n,
        count: banks[i]?._count._all ?? 0,
      })),
    };
  }

  /** How many orders sit in `status` now, and since when the oldest last changed. */
  async ordersIn(status: 'NEEDS_REVIEW' | 'HELD') {
    const row = await this.db.order.aggregate({
      where: { status },
      _count: { _all: true },
      _min: { updatedAt: true },
    });
    return { count: row._count._all, since: row._min.updatedAt };
  }

  async openPaymentReviews() {
    const row = await this.db.paymentReview.aggregate({
      where: { status: 'OPEN' },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    return { count: row._count._all, since: row._min.createdAt };
  }
}
