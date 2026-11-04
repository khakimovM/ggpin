import { Logger } from '@nestjs/common';
import type { CostSnapshot, FxRate } from '@repo/db';
import { AppError } from '../../../common/exceptions/app-error';
import type { AppConfig } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { PriceBookService } from '../price-book.service';
import type { PriceRequest, PricingSku } from '../price-book.types';
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
  // Same bounds as the Prisma queries: rows stamped after `notAfter` / `until` do not exist.
  const repository = {
    latestFxRate: jest.fn((pair: string, notAfter: Date) =>
      Promise.resolve(
        newest(book.rates.filter((rate) => rate.pair === pair && rate.createdAt <= notAfter)),
      ),
    ),
    latestCostSnapshot: jest.fn((productId: string, skuId: string | null, notAfter: Date) =>
      Promise.resolve(
        newest(
          book.snapshots.filter(
            (s) => s.productId === productId && s.skuId === skuId && s.createdAt <= notAfter,
          ),
        ),
      ),
    ),
    latestCostSnapshotsBetween: jest.fn(
      (productIds: readonly string[], since: Date, until: Date) => {
        const map = new Map<string, CostSnapshot>();
        const rows = book.snapshots
          .filter(
            (s) => productIds.includes(s.productId) && s.createdAt >= since && s.createdAt <= until,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        for (const row of rows) {
          const key = costSnapshotKey(row.productId, row.skuId);
          if (!map.has(key)) map.set(key, row);
        }
        return Promise.resolve(map);
      },
    ),
    fxRatesByIds: jest.fn((ids: readonly string[]) =>
      Promise.resolve(book.rates.filter((rate) => ids.includes(rate.id))),
    ),
  };
  return repository as unknown as PricingRepository;
}

// Config overrides are applied after loading, so a test can say NODE_ENV=production without the
// production-only env checks (https origins, 32-char secrets) that loadEnv enforces.
/** Every (productId, skuId) the service asked latestCostSnapshot for, in order. */
export function costLookups(repository: PricingRepository): [string, string | null][] {
  const lookup = (
    repository as unknown as {
      latestCostSnapshot: jest.Mock<Promise<CostSnapshot | null>, [string, string | null, Date]>;
    }
  ).latestCostSnapshot;
  return lookup.mock.calls.map(([productId, skuId]) => [productId, skuId]);
}

export function priceBook(book: FakeBook, overrides: Partial<AppConfig> = {}): PriceBookService {
  return priceBookWithRepository(book, overrides).service;
}

/** Same service, plus the fake repository so a test can see which rows were asked for. */
export function priceBookWithRepository(book: FakeBook, overrides: Partial<AppConfig> = {}) {
  const repository = bookWith(book);
  return {
    service: new PriceBookService(repository, { ...buildTestEnv(), ...overrides }),
    repository,
  };
}

/** Custom-quantity product: priced from the product-level row unless a fresh pack row exists. */
export const STARS = { id: 'p_stars', allowCustomQty: true };
/** Fixed-pack product (Premium): priced from its pack-level rows only. */
export const PREMIUM = { id: 'p_prem', allowCustomQty: false };

const spyOnWarn = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
let warnSpy: ReturnType<typeof spyOnWarn> | undefined;

// Refusals log a warning; keep the test output readable. Call once at the top of a spec file.
export function silenceRefusalLogs(): void {
  beforeEach(() => {
    warnSpy = spyOnWarn();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
}

export function request(overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    product: STARS,
    pricingSku: pack(),
    sku: { id: 'sku_50' },
    quantity: 50,
    now: NOW,
    ...overrides,
  };
}

/** Messages logged by PriceBookService refusals since the last call to expectRefused. */
export function refusalLogs(): string[] {
  if (warnSpy === undefined) throw new Error('call silenceRefusalLogs() at the top of the spec');
  return warnSpy.mock.calls.map(([message]) => (typeof message === 'string' ? message : ''));
}

/**
 * PRICE_UNAVAILABLE for exactly the given reason. The code alone is not enough: an unrelated
 * refusal (a stale row, a missing rate) answers with the same code and would let a test pass
 * for the wrong reason.
 */
export async function expectRefused(promise: Promise<unknown>, reason: string): Promise<void> {
  if (warnSpy === undefined) throw new Error('call silenceRefusalLogs() at the top of the spec');
  warnSpy.mockClear();
  expect((await failure(promise)).code).toBe('PRICE_UNAVAILABLE');
  const logs = refusalLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain(reason);
}

export async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}
