import { NOW, THIRTY_MIN_MS, ago, fx, pack, priceBook, snapshot } from './price-book.fixtures';
import { customQtyRange, pickPricingSku } from '../pricing-sku';

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

describe('customQtyRange', () => {
  const custom = { allowCustomQty: true, minQty: 50, maxQty: 1000 };
  const packs = (...quantities: number[]) => quantities.map((quantity) => ({ quantity }));

  it('is the stored bounds when the smallest active pack is not above the minimum', () => {
    expect(customQtyRange(custom, packs(50, 100))).toEqual({ min: 50, max: 1000 });
    expect(customQtyRange(custom, packs(25, 100))).toEqual({ min: 50, max: 1000 });
  });

  it('raises the minimum to the smallest active pack, whatever the input order', () => {
    expect(customQtyRange(custom, packs(500, 100))).toEqual({ min: 100, max: 1000 });
    expect(customQtyRange(custom, packs(100, 500))).toEqual({ min: 100, max: 1000 });
  });

  it('the smallest pack may equal the maximum, but not exceed it', () => {
    expect(customQtyRange(custom, packs(1000))).toEqual({ min: 1000, max: 1000 });
    expect(customQtyRange(custom, packs(1001, 2000))).toBeNull();
  });

  it('is null without an active pack, without bounds, or when custom quantity is off', () => {
    expect(customQtyRange(custom, [])).toBeNull();
    expect(customQtyRange({ ...custom, minQty: null }, packs(50))).toBeNull();
    expect(customQtyRange({ ...custom, maxQty: null }, packs(50))).toBeNull();
    expect(customQtyRange({ ...custom, allowCustomQty: false }, packs(50))).toBeNull();
  });

  it('agrees with pickPricingSku: every quantity in the range finds a pricing pack', () => {
    const skus = [pack({ id: 'a', quantity: 100 }), pack({ id: 'b', quantity: 500 })];
    const range = customQtyRange(custom, skus);
    if (range === null) throw new Error('expected a range');
    for (const quantity of [range.min, range.min + 1, 499, 500, range.max]) {
      expect(pickPricingSku(skus, quantity)).not.toBeNull();
    }
    expect(pickPricingSku(skus, range.min - 1)).toBeNull();
  });
});
