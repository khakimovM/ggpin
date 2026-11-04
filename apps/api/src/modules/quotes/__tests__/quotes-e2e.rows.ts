import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { Tracked } from './quotes-e2e.helpers';

type Db = PrismaService['client'];

export interface RowCtx {
  readonly db: Db;
  readonly sfx: string;
  readonly track: (kind: Tracked, id: string) => void;
}

export interface PackProduct {
  readonly id: string;
  readonly slug: string;
  readonly skuId: string;
}

// Small row builders for suites that need rows the shared fixtures do not have. Every row is
// registered with `track` so the suite's afterAll removes exactly what it created.

export async function createCategory(ctx: RowCtx, name: string): Promise<string> {
  const row = await ctx.db.category.create({
    data: { slug: `e2e-${name}-${ctx.sfx}`, nameUz: name, nameRu: name, sort: 99 },
  });
  ctx.track('categories', row.id);
  return row.id;
}

/**
 * An active product with one active 50-pack (+10% markup, no minimum margin). Stars-like (custom
 * quantity 50..1000) unless `custom: false`, which makes it a fixed-pack product like Premium:
 * only a pack-level cost row prices it.
 */
export async function createPackProduct(
  ctx: RowCtx,
  categoryId: string,
  name: string,
  options: { readonly custom?: boolean } = {},
): Promise<PackProduct> {
  const custom = options.custom ?? true;
  const product = await ctx.db.product.create({
    data: {
      slug: `e2e-${name}-${ctx.sfx}`,
      categoryId,
      nameUz: name,
      nameRu: name,
      imageUrl: '/images/x.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
      isActive: true,
      allowCustomQty: custom,
      minQty: custom ? 50 : null,
      maxQty: custom ? 1000 : null,
    },
  });
  ctx.track('products', product.id);
  const sku = await ctx.db.sku.create({
    data: {
      productId: product.id,
      quantity: 50,
      labelUz: '50',
      labelRu: '50',
      markupBps: 1000,
      minMarginTiyin: 0n,
      sort: 50,
    },
  });
  ctx.track('skus', sku.id);
  return { id: product.id, slug: product.slug, skuId: sku.id };
}

export interface CostSpec {
  readonly productId: string;
  /** Null: the product-level row ("cost per basisQuantity units"). */
  readonly skuId: string | null;
  readonly basisQuantity: number;
  readonly costMinor: bigint;
  readonly source: string;
  readonly createdAt: Date;
}

export async function createTonCost(ctx: RowCtx, spec: CostSpec): Promise<string> {
  const row = await ctx.db.costSnapshot.create({
    data: { ...spec, adapter: 'FRAGMENT', currency: 'TON' },
  });
  ctx.track('snapshots', row.id);
  return row.id;
}

export async function createFxRate(
  ctx: RowCtx,
  pair: 'TON_UZS' | 'TON_USDT' | 'USDT_UZS',
  rate: string,
  source: string,
  createdAt: Date,
): Promise<string> {
  const row = await ctx.db.fxRate.create({ data: { pair, rate, source, createdAt } });
  ctx.track('fxRates', row.id);
  return row.id;
}
