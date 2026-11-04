import { useQuotesE2e } from './quotes-e2e.helpers';
import { createCategory, createFxRate, createTonCost, type RowCtx } from './quotes-e2e.rows';

// The catalog advertises a custom-quantity range and POST /quotes enforces one. Both must be the
// same range: the stored bounds, raised to the smallest ACTIVE pack (a quantity below it has no
// pack to take its markup from). Real database, real routes, both sides read for the same product.

type BuildCtx = RowCtx & { readonly base: Date };

interface Pack {
  readonly quantity: number;
  readonly markupBps: number;
  readonly active?: boolean;
}

interface Fixture {
  readonly id: string;
  readonly slug: string;
  readonly sku: Readonly<Record<number, string>>;
}

interface Fixtures {
  /** Range 50..1000; the 50 pack is deactivated, 100 and 500 are active. */
  readonly gap: Fixture;
  /** Range 50..1000 but every pack is inactive: no custom quantity can be priced. */
  readonly noPack: Fixture;
  /** Range 50..1000, packs 50 and 100; the 100 pack has its own, dearer, pack-level cost. */
  readonly plain: Fixture;
}

async function customProduct(
  ctx: BuildCtx,
  categoryId: string,
  name: string,
  packs: readonly Pack[],
): Promise<Fixture> {
  const row = await ctx.db.product.create({
    data: {
      slug: `e2e-${name}-${ctx.sfx}`,
      categoryId,
      nameUz: name,
      nameRu: name,
      imageUrl: '/images/x.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
      isActive: true,
      allowCustomQty: true,
      minQty: 50,
      maxQty: 1000,
    },
  });
  ctx.track('products', row.id);
  const sku: Record<number, string> = {};
  for (const pack of packs) {
    const created = await ctx.db.sku.create({
      data: {
        productId: row.id,
        quantity: pack.quantity,
        labelUz: String(pack.quantity),
        labelRu: String(pack.quantity),
        markupBps: pack.markupBps,
        minMarginTiyin: 0n,
        isActive: pack.active ?? true,
        sort: pack.quantity,
      },
    });
    ctx.track('skus', created.id);
    sku[pack.quantity] = created.id;
  }
  await createTonCost(ctx, {
    productId: row.id,
    skuId: null,
    basisQuantity: 1,
    costMinor: 2_500_000n,
    source: 'fixture',
    createdAt: ctx.base,
  });
  return { id: row.id, slug: row.slug, sku };
}

async function build(ctx: BuildCtx): Promise<Fixtures> {
  await createFxRate(ctx, 'TON_UZS', '40000', 'fixture', ctx.base);
  const category = await createCategory(ctx, 'custom-qty');
  const gap = await customProduct(ctx, category, 'qty-gap', [
    { quantity: 50, markupBps: 1000, active: false },
    { quantity: 100, markupBps: 1000 },
    { quantity: 500, markupBps: 500 },
  ]);
  const noPack = await customProduct(ctx, category, 'qty-nopack', [
    { quantity: 50, markupBps: 1000, active: false },
  ]);
  const plain = await customProduct(ctx, category, 'qty-plain', [
    { quantity: 50, markupBps: 1000 },
    { quantity: 100, markupBps: 1000 },
  ]);
  // 100 stars at 4 000 000 nano each instead of the product-level 2 500 000.
  await createTonCost(ctx, {
    productId: plain.id,
    skuId: plain.sku[100] ?? '',
    basisQuantity: 100,
    costMinor: 400_000_000n,
    source: 'fixture',
    createdAt: ctx.base,
  });
  return { gap, noPack, plain };
}

describe('custom quantity: catalog range equals quote range (e2e)', () => {
  const t = useQuotesE2e(build);

  interface Detail {
    readonly allowCustomQty: boolean;
    readonly minQty: number | null;
    readonly maxQty: number | null;
    readonly skus: readonly { readonly quantity: number }[];
  }
  const detail = async (fixture: Fixture): Promise<Detail> => {
    const res = await t.get(`/catalog/products/${fixture.slug}`);
    expect(res.status).toBe(200);
    return res.body.data as unknown as Detail;
  };
  const quote = async (fixture: Fixture, body: Record<string, unknown>) => {
    const user = await t.newUser();
    const recipientToken = await t.token(user.id, fixture.id);
    const res = await t.post({ productId: fixture.id, recipientToken, ...body }, user);
    const count = await t.db.quote.count({ where: { userId: user.id } });
    return { res, count, userId: user.id };
  };

  it('with the smallest pack deactivated the catalog and the quote both start at the next pack', async () => {
    const { gap } = t.fixtures();
    const shown = await detail(gap);
    expect([shown.allowCustomQty, shown.minQty, shown.maxQty]).toEqual([true, 100, 1000]);
    expect(shown.skus.map((sku) => sku.quantity)).toEqual([100, 500]);

    // 99 is inside the stored 50..1000 but below every active pack: refused, with the range
    // the catalog advertised.
    const below = await quote(gap, { quantity: 99 });
    expect([below.res.status, below.res.body.error?.code]).toEqual([422, 'QTY_OUT_OF_RANGE']);
    expect(below.res.body.error?.details).toEqual({ min: 100, max: 1000 });
    expect(below.count).toBe(0);

    // The advertised minimum and maximum are both accepted.
    for (const quantity of [shown.minQty, shown.maxQty]) {
      const ok = await quote(gap, { quantity });
      expect(ok.res.status).toBe(201);
      expect(ok.count).toBe(1);
    }
  });

  it('without any active pack the catalog advertises no custom quantity and the quote refuses', async () => {
    const { noPack } = t.fixtures();
    const shown = await detail(noPack);
    expect([shown.allowCustomQty, shown.minQty, shown.maxQty]).toEqual([false, null, null]);
    const { res, count } = await quote(noPack, { quantity: 60 });
    expect([res.status, res.body.error?.code]).toEqual([422, 'QTY_OUT_OF_RANGE']);
    expect(res.body.error?.details).toEqual({ min: null, max: null });
    expect(count).toBe(0);
  });

  it('typing the size of a pack costs what tapping that pack costs', async () => {
    const { plain } = t.fixtures();
    const tapped = await quote(plain, { skuId: plain.sku[100] });
    const typed = await quote(plain, { quantity: 100 });
    expect([tapped.res.status, typed.res.status]).toEqual([201, 201]);
    // The pack-level cost (4 000 000 nano a star) applies: 0.4 TON = 16 000 so'm, +10%.
    expect(typed.res.body.data).toMatchObject({ priceTiyin: '1760000' });
    expect(typed.res.body.data?.['priceTiyin']).toBe(tapped.res.body.data?.['priceTiyin']);
    const row = await t.db.quote.findFirst({ where: { userId: typed.userId } });
    expect(row).toMatchObject({ skuId: plain.sku[100], quantity: 100 });
    expect(row?.costMinor).toBe(400_000_000n);
  });

  it('a quantity between two packs stays a custom quantity priced from the product-level cost', async () => {
    const { plain } = t.fixtures();
    const { res, userId } = await quote(plain, { quantity: 101 });
    expect(res.status).toBe(201);
    const row = await t.db.quote.findFirst({ where: { userId } });
    expect(row).toMatchObject({ skuId: null, quantity: 101 });
    expect(row?.costMinor).toBe(252_500_000n);
  });
});
