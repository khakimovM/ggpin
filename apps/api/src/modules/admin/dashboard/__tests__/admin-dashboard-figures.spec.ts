import { MoneyError } from '@repo/shared';
import { dashboardFigures, type DashboardCounts } from '../admin-dashboard-figures';
import {
  dashboardPeriod,
  periodDays,
  tashkentDay,
  tashkentDayStart,
} from '../admin-dashboard-period';
import type { DeliveredOrderSource } from '../admin-dashboard.repository';

const PERIOD = { from: new Date('2026-11-16T19:00:00Z'), to: new Date('2026-11-17T19:00:00Z') };
const NAMES = new Map([['p1', 'Stars']]);

const order = (over: Partial<DeliveredOrderSource> = {}): DeliveredOrderSource => ({
  id: 'o1',
  priceTiyin: 1_600_000n,
  discountTiyin: 100_000n,
  costCurrency: 'USDT',
  costMinor: 1_000_000n,
  createdAt: new Date('2026-11-17T05:00:00Z'),
  deliveredAt: new Date('2026-11-17T05:01:30Z'),
  productId: 'p1',
  fxRate: { pair: 'USDT_UZS', rate: '12500' },
  ...over,
});

const counts = (over: Partial<DashboardCounts> = {}): DashboardCounts => ({
  ordersCount: 0,
  finalStates: [],
  newUsersCount: 0,
  topups: { amountTiyin: 0n, count: 0, byBank: [] },
  ...over,
});

describe('dashboard period (Asia/Tashkent days)', () => {
  const now = new Date('2026-11-17T20:30:00Z'); // 01:30 on the 18th in Tashkent

  it('today starts at Tashkent midnight; week and month are 7 and 30 whole days', () => {
    expect(tashkentDayStart(now).toISOString()).toBe('2026-11-17T19:00:00.000Z');
    expect(dashboardPeriod({ period: 'today' }, now)).toEqual({
      from: new Date('2026-11-17T19:00:00Z'),
      to: now,
    });
    expect(dashboardPeriod({ period: 'week' }, now).from.toISOString()).toBe(
      '2026-11-11T19:00:00.000Z',
    );
    expect(dashboardPeriod({ period: 'month' }, now).from.toISOString()).toBe(
      '2026-10-19T19:00:00.000Z',
    );
  });

  it('range is the caller’s own instants', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-03T00:00:00.000Z';
    expect(dashboardPeriod({ period: 'range', from, to }, now)).toEqual({
      from: new Date(from),
      to: new Date(to),
    });
  });

  it('days: every Tashkent day touched, the exclusive end not counted', () => {
    expect(tashkentDay(now)).toBe('2026-11-18');
    expect(
      periodDays({ from: new Date('2026-11-16T19:00:00Z'), to: new Date('2026-11-18T19:00:00Z') }),
    ).toEqual(['2026-11-17', '2026-11-18']);
  });
});

describe('dashboardFigures', () => {
  it('revenue after discount, profit at the order’s own FX snapshot (cost rounded up)', () => {
    const { kpi, charts } = dashboardFigures(
      PERIOD,
      [order(), order({ id: 'o2', fxRate: { pair: 'USDT_UZS', rate: '12500.005' } })],
      counts({
        ordersCount: 3,
        finalStates: [
          { status: 'DELIVERED', count: 2 },
          { status: 'FAILED', count: 1 },
        ],
      }),
      NAMES,
    );
    expect(kpi.revenueTiyin).toBe('3000000');
    // 1 USDT at 12 500.005 so'm = 1 250 000.5 tiyin, rounded UP to 1 250 001.
    expect(kpi.grossProfitTiyin).toBe(String(250_000 + 249_999));
    expect(kpi.deliveryRateBps).toBe(6666);
    expect(kpi.avgDeliverySec).toBe(90);
    expect(charts.revenue).toEqual([
      { day: '2026-11-17', revenueTiyin: '3000000', profitTiyin: '499999' },
    ]);
    expect(charts.productShare).toEqual([
      { productId: 'p1', productName: 'Stars', revenueTiyin: '3000000', ordersCount: 2 },
    ]);
  });

  it('avgDeliverySec rounds the mean to the nearest second, a half up (2.4 -> 2, 2.5 -> 3, 2.6 -> 3)', () => {
    const created = new Date('2026-11-17T05:00:00.000Z');
    for (const [ms, sec] of [
      [2_400, 2],
      [2_500, 3],
      [2_600, 3],
    ] as const) {
      const delivered = new Date(created.getTime() + ms);
      const { kpi } = dashboardFigures(
        PERIOD,
        [order({ createdAt: created, deliveredAt: delivered })],
        counts(),
        NAMES,
      );
      expect([ms, kpi.avgDeliverySec]).toEqual([ms, sec]);
    }
  });

  it('a loss is a negative profit string; nothing delivered gives nulls, not zeros', () => {
    const loss = dashboardFigures(PERIOD, [order({ costMinor: 2_000_000n })], counts(), NAMES);
    expect(loss.kpi.grossProfitTiyin).toBe('-1000000');
    const empty = dashboardFigures(PERIOD, [], counts(), NAMES);
    expect(empty.kpi).toMatchObject({
      deliveryRateBps: null,
      avgDeliverySec: null,
      revenueTiyin: '0',
    });
    expect(empty.charts.revenue).toEqual([
      { day: '2026-11-17', revenueTiyin: '0', profitTiyin: '0' },
    ]);
  });

  it('an order the profit formula refuses breaks the figures instead of being skipped', () => {
    const foreign = order({ fxRate: { pair: 'TON_UZS', rate: '30000' } });
    expect(() => dashboardFigures(PERIOD, [foreign], counts(), NAMES)).toThrow(MoneyError);
  });

  it('top-ups come counted per bank; a bank with none is left out', () => {
    const { kpi, charts } = dashboardFigures(
      PERIOD,
      [],
      counts({
        topups: {
          amountTiyin: 175n,
          count: 3,
          byBank: [
            { bank: 'HUMO', amountTiyin: 125n, count: 2 },
            { bank: 'UZCARD', amountTiyin: 0n, count: 0 },
          ],
        },
      }),
      NAMES,
    );
    expect(kpi).toMatchObject({ topupsTiyin: '175', topupsCount: 3 });
    expect(charts.topupBankShare).toEqual([{ bank: 'HUMO', amountTiyin: '125', count: 2 }]);
  });
});
