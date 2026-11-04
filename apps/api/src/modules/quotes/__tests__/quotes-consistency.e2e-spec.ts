import { MINUTE_MS, useQuotesE2e, type TestUser } from './quotes-e2e.helpers';
import {
  createCategory,
  createFxRate,
  createPackProduct,
  createTonCost,
  type PackProduct,
  type RowCtx,
} from './quotes-e2e.rows';

// The catalog shows a price and POST /quotes charges one, from the same tables through the same
// service. These cases read both from the real database for the same pack, so a drift between
// "what the customer sees" and "what the customer is charged" cannot hide behind fakes. A
// future-dated FX row sits in the table throughout, to prove it is never read.

type BuildCtx = RowCtx & { readonly base: Date };

interface Packs {
  /** Product-level cost (50 stars = 550 000 tiyin) and a fresh pack-level cost (880 000). */
  readonly both: PackProduct;
  /** Only a product-level cost. */
  readonly productOnly: PackProduct;
  /** Fresh product-level cost, pack-level cost 30:00.001 old. */
  readonly stalePack: PackProduct;
}

const FROM_PRODUCT_LEVEL = '550000';
const FROM_PACK_LEVEL = '880000';

async function build(ctx: BuildCtx): Promise<Packs> {
  const { base } = ctx;
  await createFxRate(ctx, 'TON_UZS', '40000', 'fixture', base);
  // A bad write an hour in the future at an absurd rate. It is the newest TON_UZS row in the
  // table, yet every price below must still come from the 40 000 row: rows beyond the
  // one-minute clock-skew allowance are never read (latestAcceptedAt).
  await createFxRate(ctx, 'TON_UZS', '1', 'fixture', new Date(base.getTime() + 60 * MINUTE_MS));
  const category = await createCategory(ctx, 'consistency');

  const productLevel = (productId: string) =>
    createTonCost(ctx, {
      productId,
      skuId: null,
      basisQuantity: 1,
      costMinor: 2_500_000n,
      source: 'fixture',
      createdAt: base,
    });
  // 50 stars for 0.2 TON (4 000 000 nano per star, unlike the product-level 2 500 000).
  const packLevel = (product: PackProduct, createdAt: Date) =>
    createTonCost(ctx, {
      productId: product.id,
      skuId: product.skuId,
      basisQuantity: 50,
      costMinor: 200_000_000n,
      source: 'fixture',
      createdAt,
    });

  const both = await createPackProduct(ctx, category, 'cons-both');
  await productLevel(both.id);
  await packLevel(both, base);

  const productOnly = await createPackProduct(ctx, category, 'cons-product');
  await productLevel(productOnly.id);

  const stalePack = await createPackProduct(ctx, category, 'cons-stale');
  await productLevel(stalePack.id);
  await packLevel(stalePack, new Date(base.getTime() - 30 * MINUTE_MS - 1));

  return { both, productOnly, stalePack };
}

describe('catalog price vs quote price on the real database (e2e)', () => {
  const t = useQuotesE2e(build);

  const shown = async (product: PackProduct): Promise<string | null | undefined> => {
    const res = await t.get(`/catalog/products/${product.slug}`);
    expect(res.status).toBe(200);
    const skus = (res.body.data as { skus: { fromPriceTiyin: string | null }[] }).skus;
    return skus[0]?.fromPriceTiyin;
  };
  const quote = async (user: TestUser, product: PackProduct) => {
    const recipientToken = await t.token(user.id, product.id);
    return t.post({ productId: product.id, skuId: product.skuId, recipientToken }, user);
  };

  it('a pack with only a product-level cost: shown price equals the charged price', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    expect(await shown(f.productOnly)).toBe(FROM_PRODUCT_LEVEL);
    const res = await quote(user, f.productOnly);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ priceTiyin: FROM_PRODUCT_LEVEL });
  });

  it('a fresh pack-level cost beats the product-level one on both sides', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    expect(await shown(f.both)).toBe(FROM_PACK_LEVEL);
    const res = await quote(user, f.both);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ priceTiyin: FROM_PACK_LEVEL });
    const row = await t.db.quote.findFirst({ where: { userId: user.id } });
    expect(row?.costMinor).toBe(200_000_000n);
  });

  // A stale pack-level row is ignored on both sides; the fresh product-level cost prices the
  // pack, so what the customer sees is what the customer is charged.
  it('a stale pack-level cost: both fall back to the product-level price', async () => {
    const f = t.fixtures();
    const user = await t.newUser();
    expect(await shown(f.stalePack)).toBe(FROM_PRODUCT_LEVEL);
    const res = await quote(user, f.stalePack);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ priceTiyin: FROM_PRODUCT_LEVEL });
    const row = await t.db.quote.findFirst({ where: { userId: user.id } });
    // 50 stars x 2 500 000 nano (the product-level cost), not the stale 200 000 000 pack row.
    expect(row?.costMinor).toBe(125_000_000n);
  });
});
