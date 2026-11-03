import type { CostSnapshot, FxRate } from '@repo/db';
import type { AppConfig } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PriceBookService } from '../price-book.service';
import type { PricingSku } from '../price-book.types';
import { costSnapshotKey, type PricingRepository } from '../pricing.repository';

export const NOW = new Date('2026-06-01T12:00:00.000Z');
export const THIRTY_MIN_MS = 1_800_000;

export function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

export function fx(overrides: Partial<FxRate> = {}): FxRate {
  return {
    id: 'fx_ton_uzs',
    pair: 'TON_UZS',
    rate: '40000',
    source: 'fixture',
    createdAt: NOW,
    ...overrides,
  };
}

// 0.0025 TON per star (2 500 000 nano). With TON_UZS = 40 000 one star costs 100 so'm.
export function snapshot(overrides: Partial<CostSnapshot> = {}): CostSnapshot {
  return {
    id: 'cost_stars',
    productId: 'p_stars',
    skuId: null,
    adapter: 'FRAGMENT',
    currency: 'TON',
    basisQuantity: 1,
    costMinor: 2_500_000n,
    source: 'fixture',
    createdAt: NOW,
    ...overrides,
  };
}

export function pack(overrides: Partial<PricingSku> = {}): PricingSku {
  return { id: 'sku_50', quantity: 50, markupBps: 1000, minMarginTiyin: 0n, ...overrides };
}

export interface FakeBook {
  readonly rates: FxRate[];
  readonly snapshots: CostSnapshot[];
}

export function bookWith(book: FakeBook): PricingRepository {
  const newest = <T extends { createdAt: Date }>(rows: T[]): T | null =>
    [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const repository = {
    latestFxRate: jest.fn((pair: string) =>
      Promise.resolve(newest(book.rates.filter((rate) => rate.pair === pair))),
    ),
    latestCostSnapshot: jest.fn((productId: string, skuId: string | null) =>
      Promise.resolve(
        newest(book.snapshots.filter((s) => s.productId === productId && s.skuId === skuId)),
      ),
    ),
    latestCostSnapshotsSince: jest.fn((productIds: readonly string[], since: Date) => {
      const map = new Map<string, CostSnapshot>();
      const rows = book.snapshots
        .filter((s) => productIds.includes(s.productId) && s.createdAt >= since)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      for (const row of rows) {
        const key = costSnapshotKey(row.productId, row.skuId);
        if (!map.has(key)) map.set(key, row);
      }
      return Promise.resolve(map);
    }),
    fxRatesByIds: jest.fn((ids: readonly string[]) =>
      Promise.resolve(book.rates.filter((rate) => ids.includes(rate.id))),
    ),
  };
  return repository as unknown as PricingRepository;
}

// Config overrides are applied after loading, so a test can say NODE_ENV=production without the
// production-only env checks (https origins, 32-char secrets) that loadEnv enforces.
export function priceBook(book: FakeBook, overrides: Partial<AppConfig> = {}): PriceBookService {
  return new PriceBookService(bookWith(book), { ...buildTestEnv(), ...overrides });
}
