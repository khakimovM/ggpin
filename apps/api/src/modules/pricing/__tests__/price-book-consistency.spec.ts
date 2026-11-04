import { Logger } from '@nestjs/common';
import { AppError } from '../../../common/exceptions/app-error';
import type { PriceRequest } from '../price-book.types';
import { NOW, THIRTY_MIN_MS, ago, fx, pack, priceBook, snapshot } from './price-book.fixtures';

// Cross-slice checks: the catalog shows a price (displayPrices) and POST /quotes charges one
// (price()). Both read the same tables through the same service, so for the same pack they
// must agree: the same price, or "no price" on both sides.

const STARS = { id: 'p_stars' };
const SKU_50 = pack({ id: 'sku_50', quantity: 50 });
const DISPLAY_PRODUCT = { id: 'p_stars', skus: [SKU_50] };

// Stars are costed per star on the product (2 500 000 nano); this pack row says "50 stars cost
// 0.2 TON", i.e. 4 000 000 nano per star, deliberately different so the two sources are told
// apart by price: product-level 50 stars -> 550 000 tiyin, pack-level -> 880 000 tiyin.
const PRODUCT_LEVEL = snapshot({ id: 'cost_product' });
const PACK_LEVEL = snapshot({
  id: 'cost_pack',
  skuId: 'sku_50',
  basisQuantity: 50,
  costMinor: 200_000_000n,
});
const FROM_PRODUCT_LEVEL = 550_000n;
const FROM_PACK_LEVEL = 880_000n;

function request(overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    product: STARS,
    pricingSku: SKU_50,
    sku: { id: 'sku_50' },
    quantity: 50,
    now: NOW,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error.code;
}

async function displayed(book: ReturnType<typeof priceBook>): Promise<bigint | undefined> {
  return (await book.displayPrices([DISPLAY_PRODUCT], NOW))
    .get('p_stars')
    ?.skuPriceTiyin.get('sku_50');
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('catalog price and quote price for the same pack', () => {
  it('agree when only a product-level cost exists', async () => {
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL] });
    expect((await book.price(request())).priceTiyin).toBe(FROM_PRODUCT_LEVEL);
    expect(await displayed(book)).toBe(FROM_PRODUCT_LEVEL);
  });

  it('agree when a fresh pack-level cost and a fresh product-level cost both exist: the pack wins', async () => {
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL, PACK_LEVEL] });
    const quote = await book.price(request());
    expect(quote.costSnapshotId).toBe('cost_pack');
    expect(quote.priceTiyin).toBe(FROM_PACK_LEVEL);
    expect(await displayed(book)).toBe(FROM_PACK_LEVEL);
  });

  it('agree on "no price" when the pack-level cost is fresh but simulated in production', async () => {
    const simulatedPack = snapshot({ ...PACK_LEVEL, source: 'simulator' });
    const book = priceBook(
      { rates: [fx()], snapshots: [PRODUCT_LEVEL, simulatedPack] },
      { NODE_ENV: 'production' },
    );
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
    expect(await displayed(book)).toBeUndefined();
  });

  it('agree on "no price" when a fresh pack-level cost does not match the pack size', async () => {
    const wrongSize = snapshot({ ...PACK_LEVEL, basisQuantity: 100 });
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL, wrongSize] });
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
    expect(await displayed(book)).toBeUndefined();
  });

  // Both sides fall back the same way: a stale pack-level row is ignored and the fresh
  // product-level cost prices the pack, so the catalog never shows a price the quote refuses.
  it('agree when the pack-level cost is stale: both fall back to the fresh product-level cost', async () => {
    const stalePack = snapshot({ ...PACK_LEVEL, createdAt: ago(THIRTY_MIN_MS + 1) });
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL, stalePack] });

    const quote = await book.price(request());
    expect(quote.costSnapshotId).toBe('cost_product');
    expect(quote.priceTiyin).toBe(FROM_PRODUCT_LEVEL);
    expect(await displayed(book)).toBe(FROM_PRODUCT_LEVEL);
  });

  it('agree on "no price" when the pack-level cost is stale and there is no product-level cost', async () => {
    const stalePack = snapshot({ ...PACK_LEVEL, createdAt: ago(THIRTY_MIN_MS + 1) });
    const book = priceBook({ rates: [fx()], snapshots: [stalePack] });
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
    expect(await displayed(book)).toBeUndefined();
  });

  it('a pack-level cost exactly 30:00 old is still the pack price on both sides', async () => {
    const edgePack = snapshot({ ...PACK_LEVEL, createdAt: ago(THIRTY_MIN_MS) });
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL, edgePack] });
    expect((await book.price(request())).priceTiyin).toBe(FROM_PACK_LEVEL);
    expect(await displayed(book)).toBe(FROM_PACK_LEVEL);
  });
});

describe('displayPrices in production refuses what price() refuses', () => {
  const production = { NODE_ENV: 'production' } as const;
  const parents = (usdtUzs: string, tonUsdt: string) => [
    fx({ id: 'p_usdt', pair: 'USDT_UZS', rate: '12000', source: usdtUzs }),
    fx({ id: 'p_ton', pair: 'TON_USDT', rate: '3.3333', source: tonUsdt }),
  ];

  it('a simulator FX rate: no price (was only covered for a simulator cost)', async () => {
    const book = priceBook(
      { rates: [fx({ source: 'simulator' })], snapshots: [PRODUCT_LEVEL] },
      production,
    );
    expect(await displayed(book)).toBeUndefined();
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
  });

  it.each([
    ['TON_USDT', parents('cbu', 'simulator')],
    ['USDT_UZS', parents('simulator', 'binance')],
  ])('a TON_UZS derived from a simulator %s parent: no price', async (_which, rows) => {
    const derived = fx({ source: 'derived:p_ton*p_usdt' });
    const book = priceBook({ rates: [derived, ...rows], snapshots: [PRODUCT_LEVEL] }, production);
    expect(await displayed(book)).toBeUndefined();
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
  });

  it('a TON_UZS derived from real parents prices, and the same on both sides', async () => {
    const derived = fx({ source: 'derived:p_ton*p_usdt' });
    const book = priceBook(
      { rates: [derived, ...parents('cbu', 'binance')], snapshots: [PRODUCT_LEVEL] },
      production,
    );
    expect(await displayed(book)).toBe(FROM_PRODUCT_LEVEL);
    expect((await book.price(request())).priceTiyin).toBe(FROM_PRODUCT_LEVEL);
  });

  it.each([
    ['unparsable', 'derived:garbage'],
    ['missing parent', 'derived:p_ton*p_gone'],
  ])('a derived rate with an %s source fails closed', async (_label, source) => {
    const book = priceBook(
      { rates: [fx({ source }), ...parents('cbu', 'binance')], snapshots: [PRODUCT_LEVEL] },
      production,
    );
    expect(await displayed(book)).toBeUndefined();
  });
});

describe('rows stamped in the future', () => {
  // Beyond the one-minute clock-skew allowance: a bad write, never a current price.
  const beyondSkew = new Date(NOW.getTime() + 60_001);
  const withinSkew = new Date(NOW.getTime() + 30_000);

  it('only future-dated rows beyond the allowance: no price on either side', async () => {
    const book = priceBook({
      rates: [fx({ createdAt: beyondSkew })],
      snapshots: [snapshot({ createdAt: beyondSkew })],
    });
    expect(await refusal(book.price(request()))).toBe('PRICE_UNAVAILABLE');
    expect(await displayed(book)).toBeUndefined();
  });

  it('a bad future-dated FX rate does not hide the correct fresh rate beneath it', async () => {
    const book = priceBook({
      rates: [fx({ id: 'good' }), fx({ id: 'bad', rate: '1', createdAt: beyondSkew })],
      snapshots: [snapshot()],
    });
    const quote = await book.price(request());
    expect(quote.fxRateId).toBe('good');
    expect(quote.priceTiyin).toBe(FROM_PRODUCT_LEVEL);
    expect(await displayed(book)).toBe(FROM_PRODUCT_LEVEL);
  });

  it('a bad future-dated pack-level cost is ignored on both sides (product-level prices)', async () => {
    const futurePack = snapshot({ ...PACK_LEVEL, createdAt: beyondSkew });
    const book = priceBook({ rates: [fx()], snapshots: [PRODUCT_LEVEL, futurePack] });
    const quote = await book.price(request());
    expect(quote.costSnapshotId).toBe('cost_product');
    expect(await displayed(book)).toBe(FROM_PRODUCT_LEVEL);
  });

  it('rows up to a minute ahead (worker clock slightly fast) are used on both sides', async () => {
    const book = priceBook({
      rates: [fx({ createdAt: withinSkew })],
      snapshots: [PRODUCT_LEVEL, snapshot({ ...PACK_LEVEL, createdAt: withinSkew })],
    });
    const quote = await book.price(request());
    expect(quote.costSnapshotId).toBe('cost_pack');
    expect(quote.priceTiyin).toBe(FROM_PACK_LEVEL);
    expect(await displayed(book)).toBe(FROM_PACK_LEVEL);
  });
});
