import { Logger } from '@nestjs/common';
import { MoneyError } from '@repo/shared';
import type { Clock } from '../../../../common/clock/clock';
import type { AdminDashboardAlerts } from '../admin-dashboard-alerts';
import type { AdminDashboardCache, DashboardFigures } from '../admin-dashboard.cache';
import { dashboardFigures, type DashboardCounts } from '../admin-dashboard-figures';
import type { DashboardPeriod } from '../admin-dashboard-period';
import type {
  AdminDashboardRepository,
  DeliveredCursor,
  DeliveredOrderSource,
} from '../admin-dashboard.repository';
import { AdminDashboardService } from '../admin-dashboard.service';

const FROM = '2026-11-10T00:00:00.000Z';
const TO = '2026-11-17T00:00:00.000Z';
const RANGE = { period: 'range', from: FROM, to: TO } as const;

function orders(n: number): DeliveredOrderSource[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `o${String(i).padStart(4, '0')}`,
    priceTiyin: 1_000_000n + BigInt(i) * 100n,
    discountTiyin: BigInt(i % 3) * 100n,
    costCurrency: 'USDT',
    costMinor: 50_000n + BigInt(i),
    createdAt: new Date(Date.parse(FROM) + i * 60_000),
    deliveredAt: new Date(Date.parse(FROM) + i * 60_000 + 30_000 + (i % 7) * 1000),
    productId: `p${String(i % 4)}`,
    fxRate: { pair: 'USDT_UZS', rate: i % 2 === 0 ? '12500' : '12600.5' },
  }));
}

const COUNTS: DashboardCounts = {
  ordersCount: 12,
  finalStates: [{ status: 'DELIVERED', count: 11 }],
  newUsersCount: 2,
  topups: { amountTiyin: 900n, count: 1, byBank: [{ bank: 'HUMO', amountTiyin: 900n, count: 1 }] },
};

function setup(all: DeliveredOrderSource[], batchSize: number) {
  const calls = { batches: [] as (DeliveredCursor | null)[], counts: 0 };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  const repo = {
    deliveredBatch: async (_p: DashboardPeriod, cursor: DeliveredCursor | null, take: number) => {
      calls.batches.push(cursor);
      if (gated) await gate;
      const start = cursor === null ? 0 : all.findIndex((o) => o.id === cursor.id) + 1;
      return all.slice(start, start + take);
    },
    productNames: (ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, `name ${id}`]))),
    ordersCreated: () => {
      calls.counts += 1;
      return Promise.resolve(COUNTS.ordersCount);
    },
    finalStates: () => Promise.resolve(COUNTS.finalStates),
    newUsers: () => Promise.resolve(COUNTS.newUsersCount),
    topupTotals: () => Promise.resolve(COUNTS.topups),
  } as unknown as AdminDashboardRepository;
  const store = new Map<string, DashboardFigures>();
  const cache = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: DashboardFigures) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as AdminDashboardCache;
  const alerts = { current: () => Promise.resolve([]) } as unknown as AdminDashboardAlerts;
  const clock: Clock = { now: () => new Date('2026-11-17T12:00:00Z') };
  const service = new AdminDashboardService(repo, alerts, cache, clock, batchSize);
  return {
    service,
    calls,
    store,
    hold: () => {
      gated = true;
    },
    release: () => release(),
  };
}

describe('AdminDashboardService', () => {
  const period = { from: new Date(FROM), to: new Date(TO) };

  it.each([1, 3, 4, 5, 11, 12, 50])(
    'batch size %i gives exactly the figures of loading every row at once',
    async (size) => {
      const all = orders(11);
      const { service, calls } = setup(all, size);
      const got = await service.dashboard(RANGE);
      const names = new Map(['p0', 'p1', 'p2', 'p3'].map((id) => [id, `name ${id}`]));
      const expected = dashboardFigures(period, all, COUNTS, names);
      expect(got.kpi).toEqual(expected.kpi);
      expect(got.charts).toEqual(expected.charts);
      expect(got.kpi.deliveredCount).toBe(11);
      // Every batch is full except the last, then the loop stops (no extra empty read when short).
      expect(calls.batches.length).toBe(Math.floor(11 / size) + 1);
    },
  );

  it('a second request within the TTL is served from the cache (no DB read)', async () => {
    const { service, calls, store } = setup(orders(5), 2);
    const first = await service.dashboard(RANGE);
    const reads = calls.batches.length;
    const second = await service.dashboard(RANGE);
    expect(second).toEqual(first);
    expect(calls.batches.length).toBe(reads);
    expect(calls.counts).toBe(1);
    expect([...store.keys()]).toEqual([`range:${FROM}:${TO}`]);
  });

  it('another `to` is another key (computed again)', async () => {
    const { service, calls } = setup(orders(5), 10);
    await service.dashboard(RANGE);
    await service.dashboard({ ...RANGE, to: '2026-11-16T00:00:00.000Z' });
    expect(calls.counts).toBe(2);
  });

  it('single flight: two concurrent requests for one key compute once', async () => {
    const ctx = setup(orders(5), 10);
    ctx.hold();
    const a = ctx.service.dashboard(RANGE);
    const b = ctx.service.dashboard(RANGE);
    await new Promise((resolve) => setImmediate(resolve));
    ctx.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ctx.calls.counts).toBe(1);
    expect(ctx.calls.batches.length).toBe(1);
  });

  it('single flight: a failed computation is not shared or kept; the next request computes again', async () => {
    const ctx = setup(orders(3), 10);
    const repo = (ctx.service as unknown as { repo: { ordersCreated: () => Promise<number> } })
      .repo;
    const real = repo.ordersCreated;
    repo.ordersCreated = () => Promise.reject(new Error('db down'));
    await expect(ctx.service.dashboard(RANGE)).rejects.toThrow('db down');
    expect(ctx.store.size).toBe(0);
    repo.ordersCreated = real;
    const again = await ctx.service.dashboard(RANGE);
    expect(again.kpi.deliveredCount).toBe(3);
    expect(ctx.calls.counts).toBe(1);
    expect(ctx.store.size).toBe(1);
  });

  it('an order the profit formula refuses: fail closed, the log names the order id only', async () => {
    const all = orders(5);
    const bad = all[3];
    if (bad === undefined) throw new Error('fixture');
    all[3] = { ...bad, priceTiyin: 987_654_321n, fxRate: { pair: 'TON_UZS', rate: '30000' } };
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service } = setup(all, 2);
      await expect(service.dashboard(RANGE)).rejects.toBeInstanceOf(MoneyError);
      expect(errors.mock.calls).toEqual([[`dashboard profit refused for order ${bad.id}`]]);
      expect(JSON.stringify(errors.mock.calls)).not.toContain('987654321');
    } finally {
      errors.mockRestore();
    }
  });
});
