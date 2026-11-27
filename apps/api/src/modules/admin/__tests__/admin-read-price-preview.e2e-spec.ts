import { AdminPricePreviewResponseSchema } from '@repo/shared';
import { useAdminE2e } from './admin-e2e.harness';
import { purgeFixtureCatalogAround } from './admin-fixture-purge';
import { buildReadWorld, type ReadWorld } from './admin-read.fixtures';

const A = '/api/v1/admin';
const MINUTE = 60_000;
type Body = { data: unknown; error?: { code: string; details?: unknown } };

// GET /admin/products/:id/price-preview with real inputs (CR M2): the world's fresh cost snapshot
// of 1 USDT for its 50-pack (simulator data, allowed in the test env) and USDT_UZS at 12 500.
//   cost   = 1 USDT x 12 500 = 12 500 so'm = 1 250 000 tiyin
//   stored = markup 1500 bps: 1 250 000 x 1.15 = 1 437 500 (already whole so'm), margin 187 500
//   override markup 0, minimum margin 300 050: floor 1 550 050, rounded UP to whole so'm
//            = 1 550 100, margin 300 100
// The clock is the harness's: set to now, then moved past the FX age for the 503 case.
describe('admin read: price preview with real pricing inputs (real app)', () => {
  const t = useAdminE2e();
  purgeFixtureCatalogAround(t, 'ar-');
  let w: ReadWorld;
  let operator = '';
  let base = new Date();

  beforeAll(async () => {
    w = await buildReadWorld(t.db());
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
    // The world's snapshot and rate were written just now: the clock is set after them, so they
    // are the newest inputs, and fresh.
    base = new Date();
    t.clock.set(base);
  });

  const preview = async (query: string) => {
    const url = `${A}/products/${w.productId}/price-preview?skuId=${w.skuId}${query}`;
    const res = await t.request('GET', url, t.spa({ cookie: operator }));
    return { status: res.statusCode, body: res.json<Body>() };
  };

  it('the stored markup: exact price and margin', async () => {
    const { status, body } = await preview('');
    expect(status).toBe(200);
    const data = AdminPricePreviewResponseSchema.parse(body.data);
    expect(data).toMatchObject({
      costCurrency: 'USDT',
      costMinor: '1000000',
      markupBps: 1500,
      minMarginTiyin: '0',
      priceTiyin: '1437500',
      marginTiyin: '187500',
      belowMinMargin: false,
    });
    expect(data.fxRate).toMatchObject({ id: w.fxRateId, pair: 'USDT_UZS', rate: '12500' });
  });

  it('a proposed markup and minimum margin replace the stored ones', async () => {
    const { status, body } = await preview('&markupBps=0&minMarginTiyin=300050');
    expect(status).toBe(200);
    expect(AdminPricePreviewResponseSchema.parse(body.data)).toMatchObject({
      markupBps: 0,
      minMarginTiyin: '300050',
      priceTiyin: '1550100',
      marginTiyin: '300100',
      belowMinMargin: false,
    });
  });

  it('a stale FX rate is 503 PRICE_UNAVAILABLE, never a price', async () => {
    // 31 minutes later: a cost snapshot taken then is fresh, every USDT_UZS rate is not.
    const later = new Date(base.getTime() + 31 * MINUTE);
    await t.db().costSnapshot.create({
      data: {
        productId: w.productId,
        skuId: w.skuId,
        adapter: 'FRAGMENT',
        currency: 'USDT',
        basisQuantity: 50,
        costMinor: 1_000_000n,
        source: 'e2e-preview',
        createdAt: new Date(later.getTime() - 1000),
      },
    });
    t.clock.set(later);
    const { status, body } = await preview('');
    expect(status).toBe(503);
    expect(body.error?.code).toBe('PRICE_UNAVAILABLE');
    expect(body.data).toBeUndefined();
    // And for the FX reason, not the cost snapshot's (that one was taken a second ago).
    const reasons = t.logs
      .text()
      .split('\n')
      .filter((line) => line.includes(`price unavailable for product ${w.productId}`));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('USDT_UZS rate is stale');
  });
});
