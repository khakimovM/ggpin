import type { AdminDashboardResponse, DASHBOARD_ALERT_KINDS } from '@repo/shared';
import type { AreaSeries, BarRow, ChartTone, DonutSlice } from '@repo/ui';
import {
  compactSom,
  formatBps,
  formatCount,
  formatDateTime,
  formatDay,
  formatTiyin,
  formatTime,
  maxTiyin,
  ratioOf,
  sameTashkentDay,
} from '../../lib/format';

// Pure mapping from the dashboard response to what the screen draws. Money stays in BigInt:
// chart geometry gets only dimensionless ratios (format.ts `ratioOf`).

export type AlertKind = (typeof DASHBOARD_ALERT_KINDS)[number];
export type AlertTone = 'warn' | 'danger' | 'info';

export const DASHBOARD_PERIOD_IDS = ['today', 'week', 'month'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIOD_IDS)[number];

/** Where each alert leads (the screen that resolves it). */
export const ALERT_LINK: Record<AlertKind, string> = {
  ORDERS_NEEDS_REVIEW: '/review',
  ORDERS_HELD: '/review?status=HELD',
  PAYMENT_REVIEWS_OPEN: '/payments',
  FRAGMENT_SESSION_DEAD: '/fragment',
  TON_BALANCE_LOW: '/wallet',
  TON_DAILY_LIMIT_HIGH: '/wallet',
  QUEUE_FAILED_JOBS: '/queues',
  RECONCILE_MISMATCH: '/recon',
  BANK_FEED_SILENT: '/payments?tab=cards',
};

export function alertTone(alert: AdminDashboardResponse['alerts'][number]): AlertTone {
  if (alert.severity === 'critical') return 'danger';
  return alert.kind === 'TON_DAILY_LIMIT_HIGH' ? 'info' : 'warn';
}

/** "since" of an alert: the time when it began today, the date and time when earlier (R-11). */
export function sinceLabel(since: string, now: string): string {
  return sameTashkentDay(since, now) ? formatTime(since) : formatDateTime(since);
}

export interface KpiView {
  id: 'revenue' | 'profit' | 'orders' | 'deliveryRate' | 'avgDelivery' | 'newUsers' | 'topups';
  value: string;
  unit: 'som' | 'percent' | 'none';
  tone: ChartTone | 'success';
}

/** "1 daq 12 s" style parts of a duration in seconds; the words come from i18n. */
export function durationParts(seconds: number): { minutes: number; seconds: number } {
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}

export function kpiViews(kpi: AdminDashboardResponse['kpi']): KpiView[] {
  return [
    { id: 'revenue', value: formatTiyin(kpi.revenueTiyin), unit: 'som', tone: 1 },
    { id: 'profit', value: formatTiyin(kpi.grossProfitTiyin), unit: 'som', tone: 3 },
    { id: 'orders', value: formatCount(kpi.ordersCount), unit: 'none', tone: 4 },
    {
      id: 'deliveryRate',
      value: kpi.deliveryRateBps === null ? '—' : formatBps(kpi.deliveryRateBps),
      unit: kpi.deliveryRateBps === null ? 'none' : 'percent',
      tone: 'success',
    },
    { id: 'avgDelivery', value: '', unit: 'none', tone: 5 },
    { id: 'newUsers', value: formatCount(kpi.newUsersCount), unit: 'none', tone: 7 },
    { id: 'topups', value: formatTiyin(kpi.topupsTiyin), unit: 'som', tone: 2 },
  ];
}

export interface RevenueChart {
  series: AreaSeries[];
  /** The top of the axis (a round so'm figure), in tiyin. */
  top: bigint;
  xLabels: string[];
}

// The axis top: the largest value rounded up to 1, 2 or 5 x 10^n so'm.
export function niceTop(maxTiyinValue: bigint): bigint {
  if (maxTiyinValue <= 0n) return 100_000_00n;
  let step = 100n;
  while (step * 10n <= maxTiyinValue) step *= 10n;
  for (const factor of [1n, 2n, 5n, 10n]) {
    if (step * factor >= maxTiyinValue) return step * factor;
  }
  return step * 10n;
}

export function revenueChart(rows: AdminDashboardResponse['charts']['revenue']): RevenueChart {
  const top = niceTop(maxTiyin(rows.map((row) => row.revenueTiyin)));
  const ratios = (pick: (row: (typeof rows)[number]) => string) =>
    rows.map((row) => ratioOf(pick(row), top));
  const count = rows.length;
  const picks = count <= 1 ? [0] : [0, Math.floor((count - 1) / 2), count - 1];
  return {
    top,
    series: [
      { id: 'revenue', ratios: ratios((row) => row.revenueTiyin), tone: 1, fillOpacity: 0.16 },
      { id: 'profit', ratios: ratios((row) => row.profitTiyin), tone: 3, fillOpacity: 0.22 },
    ],
    xLabels: [...new Set(picks)].flatMap((index) => {
      const row = rows[index];
      return row ? [formatDay(row.day)] : [];
    }),
  };
}

/**
 * Days whose profit is below zero (R-14). The area chart starts at 0, so a loss would draw as a
 * flat zero; the screen lists these days under the chart instead: "14.11: −120 000".
 */
export function lossDays(rows: AdminDashboardResponse['charts']['revenue']): string[] {
  return rows
    .filter((row) => BigInt(row.profitTiyin) < 0n)
    .map((row) => `${formatDay(row.day)}: ${formatTiyin(row.profitTiyin)}`);
}

/** Axis texts top / middle / bottom ("5 mln", "2,5 mln", "0"); the unit word comes from i18n. */
export function axisValues(top: bigint) {
  return [compactSom(top), compactSom(top / 2n)] as const;
}

const DONUT_TONES: ChartTone[] = [2, 1, 4, 5, 6, 7, 3, 8];

export function productSlices(rows: AdminDashboardResponse['charts']['productShare']): {
  slices: DonutSlice[];
  total: number;
} {
  const total = rows.reduce((sum, row) => sum + row.ordersCount, 0);
  return {
    total,
    slices: rows.map((row, index) => {
      const ratio = total === 0 ? 0 : row.ordersCount / total;
      return {
        id: row.productId,
        label: row.productName,
        ratio,
        share: `${Math.round(ratio * 100)}%`,
        tone: DONUT_TONES[index % DONUT_TONES.length] ?? 1,
      };
    }),
  };
}

export function bankBars(
  rows: AdminDashboardResponse['charts']['topupBankShare'],
  somUnit: string,
): BarRow[] {
  const top = maxTiyin(rows.map((row) => row.amountTiyin));
  return rows.map((row, index) => ({
    id: row.bank,
    label: row.bank,
    value: `${formatTiyin(row.amountTiyin)} ${somUnit}`,
    ratio: ratioOf(row.amountTiyin, top),
    tone: index === 0 ? 1 : 5,
  }));
}
