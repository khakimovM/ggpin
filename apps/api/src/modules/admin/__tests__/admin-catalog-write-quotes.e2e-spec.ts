import { AdminPricePreviewResponseSchema, QuoteResponseSchema } from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { RecipientTokenStore, recipientTokenKey } from '../../recipients/recipient-token.store';
import { quoteLimitKey } from '../../quotes/quotes.service';
import { ACW_FX_SOURCE, catalogKit, type CatalogRows } from './admin-catalog-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S8a, the money proof of the catalog writes (docs/04 «Katalog»: «O‘zgarish mavjud
// kotirovkalarga ta’sir qilmaydi», plan §6.1). A fixed-pack product, its 3-pack priced from a
// fresh pack-level cost snapshot of 1 USDT and USDT_UZS at 12 500:
//   cost         = 1 USDT x 12 500 = 1 250 000 tiyin
//   markup 1500  = 1 250 000 x 1.15 = 1 437 500 (the quote locked before the edit)
//   markup 2000  = 1 250 000 x 1.20 = 1 500 000 (the saved package after the edit)
// Then the pack's quantity changes 3 -> 6: the snapshot prices only its own pack size, so the
// package has no price until the worker syncs its cost (503 PRICE_UNAVAILABLE, fail closed).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const cat = catalogKit(t);
const A = '/api/v1/admin';

describe('admin catalog writes vs quotes and the price preview (S8a)', () => {
  let owner: Session;
  let rows: CatalogRows;
  let userId = '';
  const tokens: string[] = [];

  beforeAll(async () => {
    owner = await kit.session('OWNER');
    userId = await kit.user();
    rows = await cat.product({ allowCustomQty: false, isActive: true, quantity: 3 });
    await t.db().costSnapshot.create({
      data: {
        productId: rows.productId,
        skuId: rows.skuId,
        adapter: 'FRAGMENT',
        currency: 'USDT',
        basisQuantity: 3,
        costMinor: 1_000_000n,
        source: 'e2e-catalog-write',
      },
    });
    // ACW_FX_SOURCE: the kit's purge removes this rate (and the snapshots, quotes and product).
    await t
      .db()
      .fxRate.create({ data: { pair: 'USDT_UZS', rate: '12500', source: ACW_FX_SOURCE } });
    // The rows above were written just now: the clock is set after them (fresh, newest).
    t.clock.set(new Date());
  });

  t.onClose(async () => {
    const redis = t.app().get(RedisService).client;
    await redis.del(quoteLimitKey(userId), ...tokens.map(recipientTokenKey));
  });

  const quote = async () => {
    const store = t.app().get(RecipientTokenStore);
    // providerRef is required since phase 5 (fulfillment re-checks the validated recipient).
    const token = await store.issue(
      userId,
      rows.productId,
      { username: 'acw_buyer', displayName: 'ACW' },
      'acw-provider-ref',
    );
    tokens.push(token);
    return t.request('POST', '/api/v1/quotes', kit.miniApp(userId), undefined, {
      productId: rows.productId,
      skuId: rows.skuId,
      recipientToken: token,
    });
  };

  const preview = async (extra = '') => {
    const url = `${A}/products/${rows.productId}/price-preview?skuId=${rows.skuId}${extra}`;
    return t.request('GET', url, t.spa({ cookie: owner.cookie }));
  };

  it('a quote keeps its locked price; the preview of the edit is the saved price; a new quote takes it', async () => {
    const before = await quote();
    expect(before.statusCode).toBe(201);
    const locked = QuoteResponseSchema.parse(dataOf(before));
    expect(locked.priceTiyin).toBe('1437500');
    const lockedRow = await t.db().quote.findUniqueOrThrow({ where: { id: locked.quoteId } });

    // What the owner sees before saving the new markup...
    const proposed = AdminPricePreviewResponseSchema.parse(
      dataOf(await preview('&markupBps=2000')),
    );
    expect(proposed.priceTiyin).toBe('1500000');

    const saved = await cat.patch(owner, `skus/${rows.skuId}`, { markupBps: 2000 });
    expect(dataOf(saved)).toMatchObject({ applied: true, sku: { markupBps: 2000 } });

    // ...is exactly what the saved package now prices at, in the preview and in a new quote.
    const stored = AdminPricePreviewResponseSchema.parse(dataOf(await preview()));
    expect(stored).toEqual(proposed);
    const after = QuoteResponseSchema.parse(dataOf(await quote()));
    expect(after.priceTiyin).toBe(proposed.priceTiyin);

    // The earlier quote is untouched: same price, cost ceiling and markup it locked.
    expect(await t.db().quote.findUniqueOrThrow({ where: { id: locked.quoteId } })).toEqual(
      lockedRow,
    );
  });

  it('a minimum-margin edit is previewed and saved alike (tiyin string, rounded up to whole so‘m)', async () => {
    const proposed = AdminPricePreviewResponseSchema.parse(
      dataOf(await preview('&markupBps=0&minMarginTiyin=300050')),
    );
    expect(proposed.priceTiyin).toBe('1550100');
    await cat.patch(owner, `skus/${rows.skuId}`, { markupBps: 0, minMarginTiyin: '300050' });
    expect(AdminPricePreviewResponseSchema.parse(dataOf(await preview()))).toEqual(proposed);
  });

  it('a changed quantity is PRICE_UNAVAILABLE (503) until the cost is synced; earlier quotes keep their price', async () => {
    const earlier = QuoteResponseSchema.parse(dataOf(await quote()));
    const earlierRow = await t.db().quote.findUniqueOrThrow({ where: { id: earlier.quoteId } });

    const moved = await cat.patch(owner, `skus/${rows.skuId}`, { quantity: 6 });
    expect(dataOf(moved)).toMatchObject({ applied: true, sku: { quantity: 6 } });

    const previewNow = await preview();
    expect(previewNow.statusCode).toBe(503);
    expect(errorOf(previewNow).code).toBe('PRICE_UNAVAILABLE');
    const quoteNow = await quote();
    expect(quoteNow.statusCode).toBe(503);
    expect(errorOf(quoteNow).code).toBe('PRICE_UNAVAILABLE');
    expect(await t.db().quote.findUniqueOrThrow({ where: { id: earlier.quoteId } })).toEqual(
      earlierRow,
    );

    // The worker's sync for the new pack size brings the price back.
    await t.db().costSnapshot.create({
      data: {
        productId: rows.productId,
        skuId: rows.skuId,
        adapter: 'FRAGMENT',
        currency: 'USDT',
        basisQuantity: 6,
        costMinor: 2_000_000n,
        source: 'e2e-catalog-write',
      },
    });
    t.clock.set(new Date());
    expect((await preview()).statusCode).toBe(200);
  });
});
