import { Logger } from '@nestjs/common';
import { COST_MAX_AGE_MS, FX_MAX_AGE_MS, maxCostFor, priceFromCost } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import type { PriceRequest } from '../price-book.types';
import { pickPricingSku } from '../pricing-sku';
import { NOW, THIRTY_MIN_MS, ago, fx, pack, priceBook, snapshot } from './price-book.fixtures';

const STARS = { id: 'p_stars' };

// Refusals log a warning; keep the test output readable.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

function request(overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    product: STARS,
    pricingSku: pack(),
    sku: { id: 'sku_50' },
    quantity: 50,
    now: NOW,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}

describe('PriceBookService.price', () => {
  it('prices a pack from the product snapshot with exact money', async () => {
    const book = priceBook({ rates: [fx()], snapshots: [snapshot()] });
    const result = await book.price(request());
    // 50 stars x 2 500 000 nano = 125 000 000 nano = 0.125 TON = 5 000 so'm; +10% = 5 500 so'm.
    expect(result).toEqual({
      costCurrency: 'TON',
      costMinor: 125_000_000n,
      costSnapshotId: 'cost_stars',
      fxRateId: 'fx_ton_uzs',
      priceTiyin: 550_000n,
      maxCostMinor: 128_750_000n, // tolerance (3%) is the lower cap
    });
  });

  it('maxCost equals the shared math, with the tolerance cap and with the margin cap binding', async () => {
    for (const toleranceBps of [300, 10_000]) {
      const book = priceBook(
        { rates: [fx()], snapshots: [snapshot()] },
        { PRICE_TOLERANCE_BPS: toleranceBps },
      );
      const result = await book.price(request());
      const { priceTiyin } = priceFromCost({
        costMinor: 125_000_000n,
        costCurrency: 'TON',
        rate: '40000',
        markupBps: 1000,
        minMarginTiyin: 0n,
      });
      expect(result.priceTiyin).toBe(priceTiyin);
      expect(result.maxCostMinor).toBe(
        maxCostFor({
          costMinor: 125_000_000n,
          costCurrency: 'TON',
          rate: '40000',
          priceTiyin,
          discountTiyin: 0n,
          minMarginTiyin: 0n,
          toleranceBps,
        }),
      );
    }
    const wide = priceBook(
      { rates: [fx()], snapshots: [snapshot()] },
      { PRICE_TOLERANCE_BPS: 10_000 },
    );
    // Tolerance would allow 250 000 000; the price only covers 137 500 000 nano at zero margin.
    expect((await wide.price(request())).maxCostMinor).toBe(137_500_000n);
  });

  it('a pack-level snapshot is used as is for its own pack', async () => {
    const premium = snapshot({
      id: 'cost_3m',
      productId: 'p_prem',
      skuId: 'sku_3m',
      basisQuantity: 3,
      costMinor: 3_000_000_000n,
    });
    const book = priceBook({ rates: [fx()], snapshots: [premium] });
    const result = await book.price(
      request({
        product: { id: 'p_prem' },
        pricingSku: pack({ id: 'sku_3m', quantity: 3 }),
        sku: { id: 'sku_3m' },
        quantity: 3,
      }),
    );
    // 3 TON = 120 000 so'm = 12 000 000 tiyin; +10% = 13 200 000.
    expect(result.costMinor).toBe(3_000_000_000n);
    expect(result.costSnapshotId).toBe('cost_3m');
    expect(result.priceTiyin).toBe(13_200_000n);
  });

  it('a pack snapshot for another quantity is refused, not rescaled', async () => {
    const wrong = snapshot({ skuId: 'sku_50', basisQuantity: 100, costMinor: 250_000_000n });
    const book = priceBook({ rates: [fx()], snapshots: [wrong] });
    expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
  });

  it('custom quantity: the largest pack not above the quantity sets markup and margin', async () => {
    const small = pack({ id: 'sku_50', quantity: 50, markupBps: 1000 });
    const large = pack({ id: 'sku_100', quantity: 100, markupBps: 500, minMarginTiyin: 0n });
    const skus = [small, large];
    expect(pickPricingSku(skus, 75)?.id).toBe('sku_50');
    const chosen = pickPricingSku(skus, 120);
    expect(chosen?.id).toBe('sku_100');
    if (chosen === null) throw new Error('unreachable');

    const book = priceBook({ rates: [fx()], snapshots: [snapshot()] });
    const result = await book.price(request({ pricingSku: chosen, sku: null, quantity: 120 }));
    // 120 stars = 300 000 000 nano = 12 000 so'm = 1 200 000 tiyin; +5% = 1 260 000.
    expect(result.costMinor).toBe(300_000_000n);
    expect(result.priceTiyin).toBe(1_260_000n);
    expect(result.costSnapshotId).toBe('cost_stars');
  });

  it('rounds the price up to a whole so‘m', async () => {
    const odd = snapshot({ costMinor: 2_500_001n });
    const book = priceBook({ rates: [fx()], snapshots: [odd] });
    const { priceTiyin } = await book.price(request());
    expect(priceTiyin % 100n).toBe(0n);
    expect(priceTiyin).toBeGreaterThanOrEqual(550_000n);
  });

  describe('freshness (strict: exactly 30:00 is still fresh)', () => {
    it('both limits are the 30 minutes of the contract', () => {
      expect(FX_MAX_AGE_MS).toBe(THIRTY_MIN_MS);
      expect(COST_MAX_AGE_MS).toBe(THIRTY_MIN_MS);
    });

    it.each([
      ['just now', 0, true],
      ['29:59.999', THIRTY_MIN_MS - 1, true],
      ['exactly 30:00', THIRTY_MIN_MS, true],
      ['30:00.001', THIRTY_MIN_MS + 1, false],
    ])('FX rate %s', async (_label, ageMs, fresh) => {
      const book = priceBook({ rates: [fx({ createdAt: ago(ageMs) })], snapshots: [snapshot()] });
      if (fresh) await expect(book.price(request())).resolves.toBeDefined();
      else expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it.each([
      ['just now', 0, true],
      ['29:59.999', THIRTY_MIN_MS - 1, true],
      ['exactly 30:00', THIRTY_MIN_MS, true],
      ['30:00.001', THIRTY_MIN_MS + 1, false],
    ])('cost snapshot %s', async (_label, ageMs, fresh) => {
      const book = priceBook({ rates: [fx()], snapshots: [snapshot({ createdAt: ago(ageMs) })] });
      if (fresh) await expect(book.price(request())).resolves.toBeDefined();
      else expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('uses the newest row: an old stale row does not matter once a fresh one exists', async () => {
      const book = priceBook({
        rates: [fx({ id: 'old', createdAt: ago(THIRTY_MIN_MS * 4) }), fx({ id: 'new' })],
        snapshots: [snapshot()],
      });
      expect((await book.price(request())).fxRateId).toBe('new');
    });

    it('a stale newest row is not rescued by an even older one', async () => {
      const book = priceBook({
        rates: [fx({ createdAt: ago(THIRTY_MIN_MS + 1) })],
        snapshots: [snapshot()],
      });
      expect((await failure(book.price(request()))).status).toBe(503);
    });
  });

  describe('missing inputs', () => {
    it('no TON_UZS rate (only its parents exist)', async () => {
      const book = priceBook({
        rates: [fx({ pair: 'TON_USDT', rate: '3' }), fx({ pair: 'USDT_UZS', rate: '12000' })],
        snapshots: [snapshot()],
      });
      const error = await failure(book.price(request()));
      expect(error.code).toBe('PRICE_UNAVAILABLE');
      expect(error.status).toBe(503);
    });

    it('no cost snapshot', async () => {
      const book = priceBook({ rates: [fx()], snapshots: [] });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('a snapshot of another product is not used', async () => {
      const book = priceBook({ rates: [fx()], snapshots: [snapshot({ productId: 'other' })] });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('a snapshot in an unknown currency', async () => {
      const book = priceBook({ rates: [fx()], snapshots: [snapshot({ currency: 'EUR' })] });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('USDT costs use the USDT_UZS pair', async () => {
      const book = priceBook({
        rates: [fx({ id: 'fx_usdt', pair: 'USDT_UZS', rate: '12500' })],
        snapshots: [snapshot({ currency: 'USDT', costMinor: 4_000_000n, basisQuantity: 1 })],
      });
      const result = await book.price(request({ quantity: 50 }));
      expect(result.fxRateId).toBe('fx_usdt');
      expect(result.costCurrency).toBe('USDT');
      // 50 x 4 USDT = 200 USDT x 12 500 = 2 500 000 so'm; +10%.
      expect(result.priceTiyin).toBe(275_000_000n);
    });
  });

  describe('simulated data (owner decision Q15: refused only in production)', () => {
    const simulatedCost = { rates: [fx()], snapshots: [snapshot({ source: 'simulator' })] };
    const simulatedFx = { rates: [fx({ source: 'simulator' })], snapshots: [snapshot()] };

    it('is accepted outside production', async () => {
      await expect(priceBook(simulatedCost).price(request())).resolves.toBeDefined();
      await expect(priceBook(simulatedFx).price(request())).resolves.toBeDefined();
      await expect(
        priceBook(simulatedFx, { NODE_ENV: 'development' }).price(request()),
      ).resolves.toBeDefined();
    });

    it('a simulator cost snapshot is refused in production', async () => {
      const book = priceBook(simulatedCost, { NODE_ENV: 'production' });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('a simulator FX rate is refused in production', async () => {
      const book = priceBook(simulatedFx, { NODE_ENV: 'production' });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('real data is accepted in production', async () => {
      const book = priceBook(
        { rates: [fx({ source: 'cbu' })], snapshots: [snapshot({ source: 'fragment' })] },
        { NODE_ENV: 'production' },
      );
      await expect(book.price(request())).resolves.toBeDefined();
    });

    describe('derived TON_UZS', () => {
      const parents = (usdtUzs: string, tonUsdt: string) => [
        fx({ id: 'p_usdt', pair: 'USDT_UZS', rate: '12000', source: usdtUzs }),
        fx({ id: 'p_ton', pair: 'TON_USDT', rate: '3.3333', source: tonUsdt }),
      ];
      const derived = fx({ source: 'derived:p_ton*p_usdt' });

      it('built from a simulator parent is refused in production', async () => {
        for (const rows of [parents('cbu', 'simulator'), parents('simulator', 'binance')]) {
          const book = priceBook(
            { rates: [derived, ...rows], snapshots: [snapshot()] },
            { NODE_ENV: 'production' },
          );
          expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
        }
      });

      it('built from real parents is accepted in production', async () => {
        const book = priceBook(
          { rates: [derived, ...parents('cbu', 'binance')], snapshots: [snapshot()] },
          { NODE_ENV: 'production' },
        );
        await expect(book.price(request())).resolves.toBeDefined();
      });

      it('is accepted outside production even from simulator parents', async () => {
        const book = priceBook({
          rates: [derived, ...parents('simulator', 'simulator')],
          snapshots: [snapshot()],
        });
        await expect(book.price(request())).resolves.toBeDefined();
      });

      it.each([
        ['an unparsable source', 'derived:garbage', parents('cbu', 'binance')],
        ['a missing parent', 'derived:p_ton*p_gone', parents('cbu', 'binance')],
        ['a parent that is itself derived', 'derived:p_ton*p_usdt', parents('derived:a*b', 'x')],
      ])('fails closed in production for %s', async (_label, source, rows) => {
        const book = priceBook(
          { rates: [fx({ source }), ...rows], snapshots: [snapshot()] },
          { NODE_ENV: 'production' },
        );
        expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
      });
    });
  });
});

describe('PriceBookService.displayPrices', () => {
  const skus = [pack({ id: 'sku_50', quantity: 50 }), pack({ id: 'sku_100', quantity: 100 })];
  const product = { id: 'p_stars', skus };

  it('prices every pack, the cheapest is the "from" price, the unit price is per star', async () => {
    const book = priceBook({ rates: [fx()], snapshots: [snapshot()] });
    const prices = (await book.displayPrices([product], NOW)).get('p_stars');
    expect(prices?.skuPriceTiyin.get('sku_50')).toBe(550_000n);
    expect(prices?.skuPriceTiyin.get('sku_100')).toBe(1_100_000n);
    expect(prices?.fromPriceTiyin).toBe(550_000n);
    expect(prices?.unitPriceTiyin).toBe(11_000n);
  });

  it('has no price when the FX rate or the cost is stale or missing', async () => {
    for (const inputs of [
      { rates: [fx({ createdAt: ago(THIRTY_MIN_MS + 1) })], snapshots: [snapshot()] },
      { rates: [fx()], snapshots: [snapshot({ createdAt: ago(THIRTY_MIN_MS + 1) })] },
      { rates: [], snapshots: [snapshot()] },
      { rates: [fx()], snapshots: [] },
    ]) {
      const prices = (await priceBook(inputs).displayPrices([product], NOW)).get('p_stars');
      expect(prices?.fromPriceTiyin).toBeNull();
      expect(prices?.unitPriceTiyin).toBeNull();
      expect(prices?.skuPriceTiyin.size).toBe(0);
    }
  });

  it('a cost exactly 30:00 old still prices', async () => {
    const book = priceBook({
      rates: [fx()],
      snapshots: [snapshot({ createdAt: ago(THIRTY_MIN_MS) })],
    });
    const prices = (await book.displayPrices([product], NOW)).get('p_stars');
    expect(prices?.fromPriceTiyin).toBe(550_000n);
  });

  it('refuses simulator data in production, like price()', async () => {
    const book = priceBook(
      { rates: [fx()], snapshots: [snapshot({ source: 'simulator' })] },
      { NODE_ENV: 'production' },
    );
    expect((await book.displayPrices([product], NOW)).get('p_stars')?.fromPriceTiyin).toBeNull();
  });

  it('makes no query for an empty list', async () => {
    const book = priceBook({ rates: [], snapshots: [] });
    expect((await book.displayPrices([], NOW)).size).toBe(0);
  });
});

describe('pickPricingSku', () => {
  const skus = [pack({ id: 'a', quantity: 50 }), pack({ id: 'b', quantity: 250 })];
  it.each([
    [49, null],
    [50, 'a'],
    [249, 'a'],
    [250, 'b'],
    [100_000, 'b'],
  ])('quantity %i -> %s', (quantity, expected) => {
    expect(pickPricingSku(skus, quantity)?.id ?? null).toBe(expected);
  });
  it('is independent of the input order', () => {
    expect(pickPricingSku([...skus].reverse(), 300)?.id).toBe('b');
  });
});
