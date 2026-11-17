import {
  orderGrossProfitTiyin,
  totalAfterDiscount,
  type AdminDashboardResponse,
} from '@repo/shared';
import { periodDays, tashkentDay, type DashboardPeriod } from './admin-dashboard-period';
import type { DeliveredOrderSource } from './admin-dashboard.repository';

export type DashboardKpi = AdminDashboardResponse['kpi'];
export type DashboardCharts = AdminDashboardResponse['charts'];
type Bank = DashboardCharts['topupBankShare'][number]['bank'];
const BPS = 10_000;

/** Confirmed top-ups of the period, already counted per bank by the database. */
export interface TopupTotals {
  readonly amountTiyin: bigint;
  readonly count: number;
  readonly byBank: readonly { bank: Bank; amountTiyin: bigint; count: number }[];
}

export interface DashboardCounts {
  readonly ordersCount: number;
  readonly finalStates: readonly { status: string; count: number }[];
  readonly newUsersCount: number;
  readonly topups: TopupTotals;
}

interface Money {
  revenue: bigint;
  profit: bigint;
}

/**
 * Revenue and profit of one delivered order. Profit is docs/03's formula through money-pricing.ts
 * (cost converted at the order's own FX snapshot, rounded up). A row the formula refuses throws:
 * a dashboard total that silently skips an order would be a wrong number on the owner's screen.
 */
function moneyOf(order: DeliveredOrderSource): Money {
  return {
    revenue: totalAfterDiscount(order.priceTiyin, order.discountTiyin),
    profit: orderGrossProfitTiyin({
      priceTiyin: order.priceTiyin,
      discountTiyin: order.discountTiyin,
      costCurrency: order.costCurrency,
      costMinor: order.costMinor,
      fxPair: order.fxRate.pair,
      rate: order.fxRate.rate,
    }),
  };
}

function deliveryRateBps(finalStates: DashboardCounts['finalStates']): number | null {
  const total = finalStates.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;
  const delivered = finalStates.find((row) => row.status === 'DELIVERED')?.count ?? 0;
  return Math.floor((delivered * BPS) / total);
}

/**
 * The delivered orders of a period folded in one batch at a time: memory is the per-day and
 * per-product maps, never the orders (SA-S4-1). `add` throws on an order the profit formula
 * refuses; `failedOrderId` then names it (the caller logs the id only).
 */
export class DashboardTally {
  private readonly byDay: Map<string, Money>;
  private readonly byProduct = new Map<string, { revenue: bigint; count: number }>();
  private readonly total: Money = { revenue: 0n, profit: 0n };
  private delivered = 0;
  private deliveryMs = 0;
  private timed = 0;
  failedOrderId: string | null = null;

  constructor(period: DashboardPeriod) {
    this.byDay = new Map(
      periodDays(period).map((day): [string, Money] => [day, { revenue: 0n, profit: 0n }]),
    );
  }

  add(orders: readonly DeliveredOrderSource[]): void {
    for (const order of orders) {
      let money: Money;
      try {
        money = moneyOf(order);
      } catch (error) {
        this.failedOrderId = order.id;
        throw error;
      }
      this.total.revenue += money.revenue;
      this.total.profit += money.profit;
      this.delivered += 1;
      if (order.deliveredAt !== null) {
        this.deliveryMs += Math.max(0, order.deliveredAt.getTime() - order.createdAt.getTime());
        this.timed += 1;
        const day = this.byDay.get(tashkentDay(order.deliveredAt));
        if (day !== undefined) {
          day.revenue += money.revenue;
          day.profit += money.profit;
        }
      }
      const product = this.byProduct.get(order.productId) ?? { revenue: 0n, count: 0 };
      product.revenue += money.revenue;
      product.count += 1;
      this.byProduct.set(order.productId, product);
    }
  }

  productIds(): string[] {
    return [...this.byProduct.keys()];
  }

  result(
    counts: DashboardCounts,
    productNames: ReadonlyMap<string, string>,
  ): { kpi: DashboardKpi; charts: DashboardCharts } {
    const { topups } = counts;
    return {
      kpi: {
        revenueTiyin: this.total.revenue.toString(),
        ordersCount: counts.ordersCount,
        deliveredCount: this.delivered,
        deliveryRateBps: deliveryRateBps(counts.finalStates),
        avgDeliverySec: this.timed === 0 ? null : Math.round(this.deliveryMs / this.timed / 1000),
        grossProfitTiyin: this.total.profit.toString(),
        newUsersCount: counts.newUsersCount,
        topupsTiyin: topups.amountTiyin.toString(),
        topupsCount: topups.count,
      },
      charts: {
        revenue: [...this.byDay].map(([day, money]) => ({
          day,
          revenueTiyin: money.revenue.toString(),
          profitTiyin: money.profit.toString(),
        })),
        productShare: [...this.byProduct]
          .sort(([, a], [, b]) => (a.revenue === b.revenue ? 0 : a.revenue > b.revenue ? -1 : 1))
          .map(([productId, row]) => ({
            productId,
            productName: productNames.get(productId) ?? '',
            revenueTiyin: row.revenue.toString(),
            ordersCount: row.count,
          })),
        topupBankShare: topups.byBank
          .filter((row) => row.count > 0)
          .map((row) => ({
            bank: row.bank,
            amountTiyin: row.amountTiyin.toString(),
            count: row.count,
          })),
      },
    };
  }
}

/** All rows at once (tests and the batch-equivalence check): the same tally, one batch. */
export function dashboardFigures(
  period: DashboardPeriod,
  delivered: readonly DeliveredOrderSource[],
  counts: DashboardCounts,
  productNames: ReadonlyMap<string, string>,
): { kpi: DashboardKpi; charts: DashboardCharts } {
  const tally = new DashboardTally(period);
  tally.add(delivered);
  return tally.result(counts, productNames);
}
