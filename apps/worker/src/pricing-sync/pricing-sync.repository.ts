import { Injectable } from '@nestjs/common';
import { MAX_CLOCK_SKEW_MS, type FxPair } from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { CostCurrency } from './cost-sources/cost-source';

export interface StoredFxRate {
  readonly id: string;
  readonly pair: string;
  readonly rate: string;
  readonly createdAt: Date;
}

export interface NewFxRate {
  readonly pair: FxPair;
  readonly rate: string;
  readonly source: string;
}

export type InsertFxRate = (row: NewFxRate) => Promise<StoredFxRate>;

/** A product with everything the cost sync decides on; filtering is the service's job. */
export interface CostCandidate {
  readonly productId: string;
  readonly isActive: boolean;
  readonly allowCustomQty: boolean;
  /** Every route, enabled or not, ordered by priority (then id, so ties are stable). */
  readonly routes: readonly { readonly adapter: string; readonly isEnabled: boolean }[];
  readonly skus: readonly {
    readonly id: string;
    readonly quantity: number;
    readonly isActive: boolean;
  }[];
}

export interface NewCostSnapshot {
  readonly productId: string;
  readonly skuId: string | null;
  readonly adapter: string;
  readonly currency: CostCurrency;
  readonly basisQuantity: number;
  readonly costMinor: bigint;
  readonly source: string;
}

const FX_RATE_FIELDS = { id: true, pair: true, rate: true, createdAt: true } as const;

/**
 * The newest createdAt a jump-guard anchor may have: `now` plus the clock skew the API also
 * tolerates. A row stamped further ahead is a bad write; as "newest" it would otherwise block
 * every correct rate (or anchor a wrong one) until real time caught up with it.
 */
export function latestAnchorCreatedAt(now: Date): Date {
  return new Date(now.getTime() + MAX_CLOCK_SKEW_MS);
}

// FxRate and CostSnapshot are immutable (UPDATE is refused by a trigger): this repository only
// ever inserts and reads.
@Injectable()
export class PricingSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The newest stored rate of `pair`, whatever its source, not stamped more than
   * MAX_CLOCK_SKEW_MS after `now`; the jump guard compares to it.
   */
  latestFxRate(pair: FxPair, now: Date): Promise<StoredFxRate | null> {
    return this.prisma.client.fxRate.findFirst({
      where: { pair, createdAt: { lte: latestAnchorCreatedAt(now) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: FX_RATE_FIELDS,
    });
  }

  /**
   * Runs `write` in one transaction: the derived TON_UZS row is stored together with the two
   * parent rows it names, or none of them is.
   */
  writeFxRates<T>(write: (insert: InsertFxRate) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction((tx) =>
      write((row) => tx.fxRate.create({ data: row, select: FX_RATE_FIELDS })),
    );
  }

  async listCostCandidates(): Promise<CostCandidate[]> {
    const products = await this.prisma.client.product.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        isActive: true,
        allowCustomQty: true,
        routes: {
          orderBy: [{ priority: 'asc' }, { id: 'asc' }],
          select: { adapter: true, isEnabled: true },
        },
        skus: { orderBy: { id: 'asc' }, select: { id: true, quantity: true, isActive: true } },
      },
    });
    return products.map(({ id, ...rest }) => ({ productId: id, ...rest }));
  }

  async insertCostSnapshots(rows: readonly NewCostSnapshot[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.client.costSnapshot.createMany({ data: [...rows] });
    return count;
  }
}

// What each service needs. Services inject the repository by class token but type it as these
// slices, so unit tests pass a plain fake without casts.
export type FxRateStore = Pick<PricingSyncRepository, 'latestFxRate' | 'writeFxRates'>;
export type CostSnapshotStore = Pick<
  PricingSyncRepository,
  'listCostCandidates' | 'insertCostSnapshots'
>;
