import { Injectable } from '@nestjs/common';
import type { CostSnapshot, FxRate } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export function costSnapshotKey(productId: string, skuId: string | null): string {
  return `${productId}:${skuId ?? ''}`;
}

// All Prisma access of the price book. Reads only: FxRate and CostSnapshot are append-only and
// written by the worker's price sync (never by the API). Every "latest" read takes an upper
// bound (`notAfter`): a row stamped further in the future is ignored, so it cannot become the
// newest price and hide the correct one (see latestAcceptedAt in price-sources.ts).
@Injectable()
export class PricingRepository {
  constructor(private readonly prisma: PrismaService) {}

  latestFxRate(pair: string, notAfter: Date): Promise<FxRate | null> {
    return this.prisma.client.fxRate.findFirst({
      where: { pair, createdAt: { lte: notAfter } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** `skuId: null` selects the product-level snapshot (Stars), not "any snapshot". */
  latestCostSnapshot(
    productId: string,
    skuId: string | null,
    notAfter: Date,
  ): Promise<CostSnapshot | null> {
    return this.prisma.client.costSnapshot.findFirst({
      where: { productId, skuId, createdAt: { lte: notAfter } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Newest snapshot per (productId, skuId) among rows created within [since, until], keyed by
   * `costSnapshotKey`. The window keeps the read bounded (the sync appends a row every few
   * minutes forever); rows outside it are stale or future-dated, so unusable anyway.
   */
  async latestCostSnapshotsBetween(
    productIds: readonly string[],
    since: Date,
    until: Date,
  ): Promise<ReadonlyMap<string, CostSnapshot>> {
    const rows = await this.prisma.client.costSnapshot.findMany({
      where: { productId: { in: [...productIds] }, createdAt: { gte: since, lte: until } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const newest = new Map<string, CostSnapshot>();
    for (const row of rows) {
      const key = costSnapshotKey(row.productId, row.skuId);
      if (!newest.has(key)) newest.set(key, row);
    }
    return newest;
  }

  fxRatesByIds(ids: readonly string[]): Promise<FxRate[]> {
    return this.prisma.client.fxRate.findMany({ where: { id: { in: [...ids] } } });
  }
}
