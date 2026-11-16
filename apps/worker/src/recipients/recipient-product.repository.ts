import { Injectable } from '@nestjs/common';
import { freshCostSnapshotWindow, latestCostSnapshotsBetween } from '@repo/db';
import { COST_CURRENCIES, type CostCurrency } from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';

/** What a recipient check needs to know about a product. `inputSchema` is unparsed JSON. */
export interface RecipientCheckProduct {
  readonly id: string;
  readonly slug: string;
  readonly isActive: boolean;
  readonly allowCustomQty: boolean;
  readonly inputSchema: unknown;
  /** The ACTIVE packs: the only SKUs a quote can be made for. */
  readonly skus: readonly { readonly id: string }[];
}

/**
 * How the API prices the product now (phase 5 S9g, D-62 (4)):
 * - `priced`: every fresh row a quote could use is in ONE currency; the newest row names it;
 * - `mixed`: fresh rows a quote could use are in different currencies (fail closed: the check
 *   cannot know which pack will be bought, so no adapter is right for all of them).
 */
export type ProductPricedBy =
  | {
      readonly kind: 'priced';
      readonly snapshotId: string;
      readonly adapter: string;
      readonly currency: CostCurrency;
    }
  | { readonly kind: 'mixed'; readonly currencies: readonly CostCurrency[] };

@Injectable()
export class RecipientProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(productId: string): Promise<RecipientCheckProduct | null> {
    return this.prisma.client.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        slug: true,
        isActive: true,
        allowCustomQty: true,
        inputSchema: true,
        skus: { where: { isActive: true }, select: { id: true } },
      },
    });
  }

  /**
   * The fresh CostSnapshot rows the API could price a new quote of this product from at `now`,
   * or null: none, or only stale/future-dated ones (the API then quotes nothing, 503
   * PRICE_UNAVAILABLE). The rows are @repo/db's `latestCostSnapshotsBetween` over
   * `freshCostSnapshotWindow(now)`: the very read and window of the API's catalog prices, so the
   * two never disagree on which rows are fresh. A quote uses the newest row of its own key: an
   * active pack's row, or (custom quantity only, Stars) the product-level row; a fixed-pack
   * product (Premium) never takes a product-level row (the API's `snapshotFor`), and a row of an
   * inactive pack backs no quote.
   *
   * Packs are NOT guaranteed to share one currency: the price sync writes a product's rows per
   * run from one adapter, but it drops a pack whose line is invalid or whose source failed, so
   * during a failover one pack can still carry the old adapter's fresh row while another has the
   * new one. The check does not know which pack will be bought, so such a product is `mixed`
   * (the lookup answers UNAVAILABLE) until the old rows age out of the window.
   */
  async pricedBy(
    product: Pick<RecipientCheckProduct, 'id' | 'allowCustomQty' | 'skus'>,
    now: Date,
  ): Promise<ProductPricedBy | null> {
    const { since, until } = freshCostSnapshotWindow(now);
    const newest = await latestCostSnapshotsBetween(this.prisma.client, [product.id], since, until);
    const activePacks = new Set(product.skus.map((sku) => sku.id));
    // Newest first, one row per key: the first usable row is the newest of them all.
    const usable = [...newest.values()].filter((row) =>
      row.skuId === null ? product.allowCustomQty : activePacks.has(row.skuId),
    );
    const first = usable[0];
    if (first === undefined) return null;
    const currencies: CostCurrency[] = [];
    for (const row of usable) {
      const currency = COST_CURRENCIES.find((c) => c === row.currency);
      // A CHECK keeps the column to TON | USDT; a row the API cannot price is no answer.
      if (currency === undefined) return null;
      if (!currencies.includes(currency)) currencies.push(currency);
    }
    const [currency] = currencies;
    if (currencies.length > 1 || currency === undefined) return { kind: 'mixed', currencies };
    return { kind: 'priced', snapshotId: first.id, adapter: first.adapter, currency };
  }
}
