import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { MINUTE_MS, type Tracked } from './quotes-e2e.helpers';

type Db = PrismaService['client'];

export interface ProductFixture {
  readonly id: string;
  /** SKU ids by pack quantity. */
  readonly sku: Readonly<Record<number, string>>;
}

export interface QuoteFixtures {
  readonly fxId: string;
  /** Custom-quantity Stars: 50 and 100 packs (+10%), an inactive 500 pack, range 50..1000. */
  readonly stars: ProductFixture & { readonly costId: string };
  /** Same price inputs, but the minimum margin (not the tolerance) caps what we may pay. */
  readonly margin: ProductFixture & { readonly costId: string };
  /** Fixed 3-month pack with a pack-level cost; no custom quantity. */
  readonly premium: ProductFixture & { readonly costId: string };
  readonly inactive: ProductFixture;
  /** Active product with a pack but no cost snapshot yet. */
  readonly noCost: ProductFixture;
  /** Cost snapshot stamped one hour ahead, so only the FX age decides freshness. */
  readonly fxProbe: ProductFixture;
  /** Cost snapshot exactly 30:00 old at the start of a test: still fresh. */
  readonly costEdge: ProductFixture;
  /** Cost snapshot 30:00.001 old at the start of a test: stale. */
  readonly costStale: ProductFixture;
}

interface Ctx {
  readonly db: Db;
  readonly base: Date;
  readonly sfx: string;
  readonly track: (kind: Tracked, id: string) => void;
}

interface ProductSpec {
  readonly name: string;
  readonly categoryId: string;
  readonly active?: boolean;
  readonly custom?: boolean;
}

interface SkuSpec {
  readonly quantity: number;
  readonly markupBps: number;
  readonly minMarginTiyin?: bigint;
  readonly active?: boolean;
}

// Numbers used by the specs (TON_UZS = 40 000 so'm per TON; 1 star costs 2 500 000 nano):
//   50 stars = 125 000 000 nano = 0.125 TON = 5 000 so'm = 500 000 tiyin.
export async function buildQuoteFixtures(ctx: Ctx): Promise<QuoteFixtures> {
  const { db, base, sfx, track } = ctx;

  const category = await db.category.create({
    data: { slug: `e2e-quote-${sfx}`, nameUz: 'Quote', nameRu: 'Quote', sort: 99 },
  });
  track('categories', category.id);

  const product = async (spec: ProductSpec, skus: readonly SkuSpec[]): Promise<ProductFixture> => {
    const row = await db.product.create({
      data: {
        slug: `e2e-quote-${spec.name}-${sfx}`,
        categoryId: spec.categoryId,
        nameUz: spec.name,
        nameRu: spec.name,
        imageUrl: '/images/x.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
        isActive: spec.active ?? true,
        allowCustomQty: spec.custom ?? false,
        minQty: spec.custom ? 50 : null,
        maxQty: spec.custom ? 1000 : null,
      },
    });
    track('products', row.id);
    const sku: Record<number, string> = {};
    for (const s of skus) {
      const created = await db.sku.create({
        data: {
          productId: row.id,
          quantity: s.quantity,
          labelUz: String(s.quantity),
          labelRu: String(s.quantity),
          markupBps: s.markupBps,
          minMarginTiyin: s.minMarginTiyin ?? 0n,
          isActive: s.active ?? true,
          sort: s.quantity,
        },
      });
      track('skus', created.id);
      sku[s.quantity] = created.id;
    }
    return { id: row.id, sku };
  };

  const cost = async (
    productId: string,
    skuId: string | null,
    basisQuantity: number,
    costMinor: bigint,
    createdAt: Date,
  ): Promise<string> => {
    const row = await db.costSnapshot.create({
      data: {
        productId,
        skuId,
        adapter: 'FRAGMENT',
        currency: 'TON',
        basisQuantity,
        costMinor,
        source: 'fixture',
        createdAt,
      },
    });
    track('snapshots', row.id);
    return row.id;
  };

  const fx = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '40000', source: 'fixture', createdAt: base },
  });
  track('fxRates', fx.id);

  const perStar = 2_500_000n;
  const packs = [
    { quantity: 50, markupBps: 1000 },
    { quantity: 100, markupBps: 1000 },
  ];

  const starsProduct = await product({ name: 'stars', categoryId: category.id, custom: true }, [
    ...packs,
    { quantity: 500, markupBps: 1000, active: false },
  ]);
  const stars = { ...starsProduct, costId: await cost(starsProduct.id, null, 1, perStar, base) };

  // markup 0 and a 10 000-tiyin minimum margin: price = 510 000 tiyin, and the margin cap
  // (510 000 - 10 000 = 500 000 tiyin = 125 000 000 nano) is below the 3% tolerance cap.
  const marginProduct = await product({ name: 'margin', categoryId: category.id, custom: true }, [
    { quantity: 50, markupBps: 0, minMarginTiyin: 10_000n },
  ]);
  const margin = { ...marginProduct, costId: await cost(marginProduct.id, null, 1, perStar, base) };

  const premiumProduct = await product({ name: 'premium', categoryId: category.id }, [
    { quantity: 3, markupBps: 1000 },
  ]);
  const premium = {
    ...premiumProduct,
    costId: await cost(premiumProduct.id, premiumProduct.sku[3] ?? '', 3, 3_000_000_000n, base),
  };

  const inactive = await product({ name: 'inactive', categoryId: category.id, active: false }, [
    { quantity: 50, markupBps: 1000 },
  ]);

  const noCost = await product({ name: 'nocost', categoryId: category.id }, [
    { quantity: 50, markupBps: 1000 },
  ]);

  const probeCosts = [
    { name: 'fxprobe', createdAt: new Date(base.getTime() + 60 * MINUTE_MS) },
    { name: 'costedge', createdAt: new Date(base.getTime() - 30 * MINUTE_MS) },
    { name: 'coststale', createdAt: new Date(base.getTime() - 30 * MINUTE_MS - 1) },
  ];
  const probes: ProductFixture[] = [];
  for (const probe of probeCosts) {
    const created = await product({ name: probe.name, categoryId: category.id }, [
      { quantity: 50, markupBps: 1000 },
    ]);
    // Product-level cost per star (scope "product"): any pack quantity scales from it.
    await cost(created.id, null, 1, perStar, probe.createdAt);
    probes.push(created);
  }
  const [fxProbe, costEdge, costStale] = probes;
  if (fxProbe === undefined || costEdge === undefined || costStale === undefined) {
    throw new Error('probe fixtures missing');
  }

  return { fxId: fx.id, stars, margin, premium, inactive, noCost, fxProbe, costEdge, costStale };
}
