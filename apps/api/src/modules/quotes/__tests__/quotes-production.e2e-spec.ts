import { useQuotesE2e, type QuotesE2e, type TestUser } from './quotes-e2e.helpers';
import {
  createCategory,
  createFxRate,
  createPackProduct,
  createTonCost,
  type PackProduct,
  type RowCtx,
} from './quotes-e2e.rows';

// Simulated (dry-run) prices become a customer quote only with the explicit opt-in
// PRICING_ALLOW_SIMULATED=true outside production; production never accepts them, and neither
// does a non-production app without the opt-in. These suites boot the whole app
// (real Postgres, real routes, real PriceBookService) and write FX and cost rows the way the
// worker does, so the refusal is proven end to end and not only on the service with fakes.
// Only the config object says "production" (see QuotesE2eOptions): no real secrets involved.

type BuildCtx = RowCtx & { readonly base: Date };

interface Products {
  readonly real: PackProduct;
  readonly simulatedCost: PackProduct;
}

// 50 stars cost 125 000 000 nano; at TON_UZS 40 000 that is 5 000 so'm, +10% = 550 000 tiyin.
const PRICE = '550000';

// FX rows are global: the newest TON_UZS row of the database wins. Each case therefore writes
// its row one second after the previous one (also across the two suites below) and moves the
// app clock to that instant, so the case's row is the newest and every row stays fresh.
let step = 0;

function register(label: string, t: QuotesE2e<Products>, refused: boolean): void {
  const quote = async (user: TestUser, product: PackProduct) => {
    const recipientToken = await t.token(user.id, product.id);
    return t.post({ productId: product.id, skuId: product.skuId, recipientToken }, user);
  };
  const quoteCount = (userId: string) => t.db.quote.count({ where: { userId } });

  // Writes a TON_UZS row and moves the clock to it.
  const withFx = async (source: string, derivedFrom?: readonly [string, string]) => {
    step += 1;
    const at = new Date(t.base.getTime() + step * 1000);
    t.setNow(at);
    const rowCtx = { db: t.db, sfx: 'fx', track: t.track };
    const parents =
      derivedFrom === undefined
        ? null
        : [
            await createFxRate(rowCtx, 'TON_USDT', '3.5', derivedFrom[0], at),
            await createFxRate(rowCtx, 'USDT_UZS', '11428.571428', derivedFrom[1], at),
          ];
    const rowSource = parents === null ? source : `derived:${parents[0] ?? ''}*${parents[1] ?? ''}`;
    return createFxRate(rowCtx, 'TON_UZS', '40000', rowSource, at);
  };

  describe(label, () => {
    it('real sources: the quote is issued and stores the FX row it used', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const fxId = await withFx('cbu');
      const res = await quote(user, f.real);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ priceTiyin: PRICE });
      const row = await t.db.quote.findFirst({ where: { userId: user.id } });
      expect(row?.fxRateId).toBe(fxId);
    });

    it('a derived TON_UZS built from real parents is accepted', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const fxId = await withFx('', ['binance', 'cbu']);
      const res = await quote(user, f.real);
      expect(res.status).toBe(201);
      expect((await t.db.quote.findFirst({ where: { userId: user.id } }))?.fxRateId).toBe(fxId);
    });

    describe.each([
      ['a simulator TON_UZS rate', () => withFx('simulator')],
      [
        'a TON_UZS derived from a simulator TON_USDT parent',
        () => withFx('', ['simulator', 'cbu']),
      ],
      [
        'a TON_UZS derived from a simulator USDT_UZS parent',
        () => withFx('', ['binance', 'simulator']),
      ],
    ])('%s', (_name, writeFx) => {
      it(
        refused ? 'is refused: 503 PRICE_UNAVAILABLE and no Quote row' : 'is accepted',
        async () => {
          const f = t.fixtures();
          const user = await t.newUser();
          await writeFx();
          const res = await quote(user, f.real);
          if (refused) {
            expect([res.status, res.body.error?.code]).toEqual([503, 'PRICE_UNAVAILABLE']);
            expect(res.headers['cache-control']).toBe('no-store');
            expect(await quoteCount(user.id)).toBe(0);
          } else {
            expect(res.status).toBe(201);
            expect(await quoteCount(user.id)).toBe(1);
          }
        },
      );
    });

    it(
      refused
        ? 'a simulator cost snapshot is refused even with a real rate'
        : 'a simulator cost snapshot is accepted',
      async () => {
        const f = t.fixtures();
        const user = await t.newUser();
        await withFx('cbu');
        const res = await quote(user, f.simulatedCost);
        if (refused) {
          expect([res.status, res.body.error?.code]).toEqual([503, 'PRICE_UNAVAILABLE']);
          expect(await quoteCount(user.id)).toBe(0);
        } else {
          expect(res.status).toBe(201);
        }
      },
    );

    it(
      refused
        ? 'the catalog shows no price for what the quote refuses, still as a 200'
        : 'the catalog shows the simulated price',
      async () => {
        const f = t.fixtures();
        await withFx('simulator');
        const res = await t.get(`/catalog/products/${f.real.slug}`);
        expect(res.status).toBe(200);
        const skus = (res.body.data as { skus: { fromPriceTiyin: string | null }[] }).skus;
        expect(skus.map((sku) => sku.fromPriceTiyin)).toEqual([refused ? null : PRICE]);
      },
    );
  });
}

async function build(ctx: BuildCtx): Promise<Products> {
  const category = await createCategory(ctx, 'prod-cat');
  const costOf = (productId: string, source: string) =>
    createTonCost(ctx, {
      productId,
      skuId: null,
      basisQuantity: 1,
      costMinor: 2_500_000n,
      source,
      createdAt: ctx.base,
    });
  const real = await createPackProduct(ctx, category, 'prod-real');
  await costOf(real.id, 'fragment');
  const simulatedCost = await createPackProduct(ctx, category, 'prod-sim');
  await costOf(simulatedCost.id, 'simulator');
  return { real, simulatedCost };
}

// The test env builder sets PRICING_ALLOW_SIMULATED=true, so this one proves the NODE_ENV check
// on its own (the flag cannot unlock production).
describe('simulated prices with NODE_ENV=production (e2e)', () => {
  register('production', useQuotesE2e(build, { config: { NODE_ENV: 'production' } }), true);
});

describe('simulated prices with PRICING_ALLOW_SIMULATED=false outside production (e2e)', () => {
  register(
    'opt-in off',
    useQuotesE2e(build, { config: { NODE_ENV: 'development', PRICING_ALLOW_SIMULATED: false } }),
    true,
  );
});

describe('the same inputs with the opt-in (control: the refusal comes from the config)', () => {
  register('opt-in on', useQuotesE2e(build), false);
});
