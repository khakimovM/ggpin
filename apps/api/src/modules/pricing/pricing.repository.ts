import { Injectable } from '@nestjs/common';
import {
  latestCostSnapshot,
  latestCostSnapshotsBetween,
  type CostSnapshot,
  type FxRate,
} from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export { costSnapshotKey } from '@repo/db';

// All Prisma access of the price book. Reads only: FxRate and CostSnapshot are append-only and
// written by the worker's price sync (never by the API). Every "latest" read takes an upper
// bound (`notAfter`): a row stamped further in the future is ignored, so it cannot become the
// newest price and hide the correct one (see latestAcceptedAt in price-sources.ts). The
// CostSnapshot reads are @repo/db's (pricing/cost-snapshots.ts): the worker's recipient check
// selects with the very same queries (phase 5 S9g).
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
    return latestCostSnapshot(this.prisma.client, productId, skuId, notAfter);
  }

  /**
   * Newest snapshot per (productId, skuId) among rows created within [since, until], keyed by
   * `costSnapshotKey`. Rows outside the window are stale or future-dated, so unusable anyway.
   */
  latestCostSnapshotsBetween(
    productIds: readonly string[],
    since: Date,
    until: Date,
  ): Promise<ReadonlyMap<string, CostSnapshot>> {
    return latestCostSnapshotsBetween(this.prisma.client, productIds, since, until);
  }

  fxRatesByIds(ids: readonly string[]): Promise<FxRate[]> {
    return this.prisma.client.fxRate.findMany({ where: { id: { in: [...ids] } } });
  }
}
