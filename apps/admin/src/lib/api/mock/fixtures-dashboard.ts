// Dashboard fixture (Admin.dc.html sample figures, P2P banks instead of payment providers).
import { AdminDashboardResponseSchema, type AdminDashboardResponse } from '@repo/shared';
import { MOCK_NOW, ago, mid } from './data-common';

const DAY_MS = 86_400_000;
const DAYS: Record<string, number> = { today: 1, week: 7, month: 30 };

// Daily revenue in so'm, profit about 9-11 % of it (sample curve).
const REVENUE_SOM = [
  31_200_000, 35_800_000, 29_400_000, 41_000_000, 44_600_000, 38_900_000, 48_200_000, 36_100_000,
  33_700_000, 40_800_000, 45_300_000, 39_900_000, 42_700_000, 47_500_000, 30_600_000, 34_200_000,
  37_800_000, 43_100_000, 46_000_000, 41_400_000, 35_500_000, 38_300_000, 44_900_000, 49_600_000,
  32_800_000, 36_700_000, 40_200_000, 45_800_000, 43_300_000, 48_200_000,
];

function tashkentDay(ms: number): string {
  return new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);
}

const tiyin = (som: number) => `${som}00`;

export function dashboardFixture(period: string, empty: boolean): AdminDashboardResponse {
  const days = DAYS[period] ?? 1;
  const revenue = empty
    ? []
    : REVENUE_SOM.slice(-days).map((som, index) => ({
        day: tashkentDay(MOCK_NOW - (days - 1 - index) * DAY_MS),
        revenueTiyin: tiyin(som),
        profitTiyin: tiyin(Math.round(som * (0.092 + 0.02 * Math.sin(index / 3)))),
      }));
  const scale = days;
  return AdminDashboardResponseSchema.parse({
    period: { from: ago(days * 24 * 60), to: new Date(MOCK_NOW).toISOString() },
    kpi: empty
      ? {
          revenueTiyin: '0',
          ordersCount: 0,
          deliveredCount: 0,
          deliveryRateBps: null,
          avgDeliverySec: null,
          grossProfitTiyin: '0',
          newUsersCount: 0,
          topupsTiyin: '0',
          topupsCount: 0,
        }
      : {
          revenueTiyin: tiyin(48_200_000 * scale),
          ordersCount: 1284 * scale,
          deliveredCount: 1276 * scale,
          deliveryRateBps: 9940,
          avgDeliverySec: 72,
          grossProfitTiyin: tiyin(4_900_000 * scale),
          newUsersCount: 312 * scale,
          topupsTiyin: tiyin(51_700_000 * scale),
          topupsCount: 940 * scale,
        },
    charts: {
      revenue,
      productShare: empty
        ? []
        : [
            ['Telegram Stars', 42],
            ['PUBG Mobile', 21],
            ['Telegram Premium', 18],
            ['Mobile Legends', 11],
            ['Steam', 5],
            ['Roblox', 3],
          ].map(([name, share], index) => ({
            productId: mid('prod', index + 1),
            productName: String(name),
            revenueTiyin: tiyin(Number(share) * 482_000 * scale),
            ordersCount: Math.round((Number(share) * 1284 * scale) / 100),
          })),
      topupBankShare: empty
        ? []
        : [
            { bank: 'HUMO', amountTiyin: tiyin(30_400_000 * scale), count: 560 * scale },
            { bank: 'UZCARD', amountTiyin: tiyin(21_300_000 * scale), count: 380 * scale },
          ],
    },
    alerts: empty
      ? []
      : [
          { kind: 'ORDERS_NEEDS_REVIEW', severity: 'warning', count: 3, since: ago(8) },
          { kind: 'PAYMENT_REVIEWS_OPEN', severity: 'warning', count: 2, since: ago(25) },
          { kind: 'TON_DAILY_LIMIT_HIGH', severity: 'warning', count: null, since: null },
          { kind: 'FRAGMENT_SESSION_DEAD', severity: 'critical', count: null, since: ago(12) },
          { kind: 'RECONCILE_MISMATCH', severity: 'critical', count: 1, since: ago(380) },
        ],
  });
}
