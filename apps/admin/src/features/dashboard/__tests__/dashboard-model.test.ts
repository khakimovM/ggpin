import { DASHBOARD_ALERT_KINDS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  ALERT_LINK,
  alertTone,
  bankBars,
  kpiViews,
  lossDays,
  niceTop,
  productSlices,
  revenueChart,
  sinceLabel,
} from '../dashboard-model';

const NNBSP = '\u202F';

describe('dashboard mapping', () => {
  it('every alert kind leads to a screen of the panel', () => {
    for (const kind of DASHBOARD_ALERT_KINDS) expect(ALERT_LINK[kind]).toMatch(/^\/[a-z]/);
  });

  it('colours alerts by severity, the daily-limit warning as info', () => {
    expect(
      alertTone({ kind: 'FRAGMENT_SESSION_DEAD', severity: 'critical', count: null, since: null }),
    ).toBe('danger');
    expect(
      alertTone({ kind: 'ORDERS_NEEDS_REVIEW', severity: 'warning', count: 3, since: null }),
    ).toBe('warn');
    expect(
      alertTone({ kind: 'TON_DAILY_LIMIT_HIGH', severity: 'warning', count: null, since: null }),
    ).toBe('info');
  });

  it('formats KPI money with formatMoney and keeps missing rates as a dash', () => {
    const views = kpiViews({
      revenueTiyin: '4820000000',
      ordersCount: 1284,
      deliveredCount: 1276,
      deliveryRateBps: null,
      avgDeliverySec: 72,
      grossProfitTiyin: '-49000000',
      newUsersCount: 312,
      topupsTiyin: '0',
      topupsCount: 0,
    });
    expect(views.find((v) => v.id === 'revenue')?.value).toBe(`48${NNBSP}200${NNBSP}000`);
    expect(views.find((v) => v.id === 'profit')?.value).toBe(`\u2212490${NNBSP}000`);
    expect(views.find((v) => v.id === 'deliveryRate')).toMatchObject({ value: '—', unit: 'none' });
    expect(views.find((v) => v.id === 'orders')?.value).toBe(`1${NNBSP}284`);
  });

  it('rounds the revenue axis up to 1 / 2 / 5 x 10^n so‘m', () => {
    expect(niceTop(4_960_000_000n)).toBe(5_000_000_000n);
    expect(niceTop(1_100_000_000n)).toBe(2_000_000_000n);
    expect(niceTop(0n)).toBe(10_000_000n);
  });

  it('draws revenue as ratios of the axis top, with day labels', () => {
    const chart = revenueChart([
      { day: '2026-11-15', revenueTiyin: '2500000000', profitTiyin: '-100' },
      { day: '2026-11-16', revenueTiyin: '5000000000', profitTiyin: '500000000' },
    ]);
    expect(chart.top).toBe(5_000_000_000n);
    expect(chart.series[0]?.ratios).toEqual([0.5, 1]);
    expect(chart.series[1]?.ratios).toEqual([0, 0.1]);
    expect(chart.xLabels).toHaveLength(2);
  });

  it('shares products by order count and banks by amount', () => {
    const { slices, total } = productSlices([
      { productId: 'a', productName: 'Stars', revenueTiyin: '1', ordersCount: 3 },
      { productId: 'b', productName: 'PUBG', revenueTiyin: '1', ordersCount: 1 },
    ]);
    expect(total).toBe(4);
    expect(slices.map((s) => s.share)).toEqual(['75%', '25%']);
    const bars = bankBars(
      [
        { bank: 'HUMO', amountTiyin: '3040000000', count: 1 },
        { bank: 'UZCARD', amountTiyin: '1520000000', count: 1 },
      ],
      'so‘m',
    );
    expect(bars.map((b) => b.ratio)).toEqual([1, 0.5]);
    expect(bars[0]?.value).toBe(`30${NNBSP}400${NNBSP}000 so‘m`);
  });

  it('lists loss days under the chart, which cannot draw below zero (R-14)', () => {
    const rows = [
      { day: '2026-11-15', revenueTiyin: '100000000', profitTiyin: '9000000' },
      { day: '2026-11-16', revenueTiyin: '50000000', profitTiyin: '-12000000' },
      { day: '2026-11-17', revenueTiyin: '0', profitTiyin: '0' },
    ];
    expect(lossDays(rows)).toEqual([`16.11: −120${NNBSP}000`]);
    expect(lossDays(rows.slice(0, 1))).toEqual([]);
  });

  it('shows an alert start as a time today and with its date before today (R-11)', () => {
    const now = '2026-11-17T09:12:00Z';
    expect(sinceLabel('2026-11-17T04:00:00Z', now)).toBe('09:00:00');
    expect(sinceLabel('2026-11-16T04:00:00Z', now)).toBe('16.11.2026 09:00');
  });
});
