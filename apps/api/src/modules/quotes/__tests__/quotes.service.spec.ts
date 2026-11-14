import { QUOTE_LIMIT, quoteLimitKey } from '../quotes.service';
import { AppError } from '../../../common/exceptions/app-error';
import {
  NOW,
  RECIPIENT,
  TOKEN,
  bySku,
  byQty,
  failure,
  product,
  setup,
  sku,
} from './quotes.fixtures';

describe('QuotesService.create', () => {
  it('runs limit, product, token, price, insert in that order and writes once', async () => {
    const { service, calls } = setup();
    await service.create('u1', bySku());
    expect(calls).toEqual(['limit', 'product', 'token', 'price', 'insert']);
  });

  it('a fixed pack is priced with its own SKU, quantity and sku ref', async () => {
    const { service, priceBook, repository } = setup();
    const out = await service.create('u1', bySku({ skuId: 's100' }));
    expect(priceBook.price).toHaveBeenCalledWith({
      product: { id: 'p1', allowCustomQty: true },
      pricingSku: { id: 's100', quantity: 100, markupBps: 1100, minMarginTiyin: 100n },
      sku: { id: 's100' },
      quantity: 100,
      now: NOW,
    });
    expect(repository.create).toHaveBeenCalledWith('u1', {
      productId: 'p1',
      skuId: 's100',
      quantity: 100,
      recipient: RECIPIENT,
      // The token record's provider-side id is stored on the quote (docs/06 S2).
      providerRef: 'fragment-ref-1',
      costCurrency: 'TON',
      costMinor: 125_000_000n,
      fxRateId: 'fx_1',
      costSnapshotId: 'cost_1',
      priceTiyin: 550_000n,
      maxCostMinor: 128_750_000n,
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    expect(out.quoteId).toBe('q1');
  });

  it('a custom quantity is priced from the largest pack not above it, with sku null', async () => {
    const { service, priceBook, repository } = setup();
    await service.create('u1', byQty(250));
    expect(priceBook.price).toHaveBeenCalledWith({
      product: { id: 'p1', allowCustomQty: true },
      pricingSku: { id: 's100', quantity: 100, markupBps: 1100, minMarginTiyin: 100n },
      sku: null,
      quantity: 250,
      now: NOW,
    });
    expect(repository.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ skuId: null, quantity: 250 }),
    );
  });

  it('takes the user id only from its argument', async () => {
    const { service, counter, repository, tokens } = setup();
    await service.create('user-A', bySku());
    expect(counter.hit).toHaveBeenCalledWith(quoteLimitKey('user-A'), QUOTE_LIMIT.windowSec);
    expect(tokens.resolve).toHaveBeenCalledWith(TOKEN, 'user-A', 'p1');
    expect(repository.create).toHaveBeenCalledWith('user-A', expect.anything());
  });

  it('a quote over the limit is RATE_LIMITED with Retry-After and nothing else runs', async () => {
    const { service, counter, repository } = setup();
    counter.hit.mockResolvedValueOnce({ count: QUOTE_LIMIT.max + 1, ttlSec: 41 });
    const error = await failure(service.create('u1', bySku()));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.headers).toEqual({ 'Retry-After': '41' });
    expect(repository.findProductWithActiveSkus).not.toHaveBeenCalled();
  });

  it('the 30th quote of a window still passes', async () => {
    const { service, counter } = setup();
    counter.hit.mockResolvedValueOnce({ count: QUOTE_LIMIT.max, ttlSec: 41 });
    await expect(service.create('u1', bySku())).resolves.toBeDefined();
  });

  it('unknown product is NOT_FOUND, inactive is PRODUCT_UNAVAILABLE', async () => {
    expect((await failure(setup(null).service.create('u1', bySku()))).code).toBe('NOT_FOUND');
    const inactive = setup(product({ isActive: false }));
    expect((await failure(inactive.service.create('u1', bySku()))).code).toBe(
      'PRODUCT_UNAVAILABLE',
    );
    expect(inactive.tokens.resolve).not.toHaveBeenCalled();
  });

  it('a SKU that is not an active pack of the product is PRODUCT_UNAVAILABLE', async () => {
    const { service, repository } = setup();
    const error = await failure(service.create('u1', bySku({ skuId: 'other-or-inactive' })));
    expect(error.code).toBe('PRODUCT_UNAVAILABLE');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('custom quantity outside [min, max] is QTY_OUT_OF_RANGE with {min, max}', async () => {
    for (const quantity of [49, 1001]) {
      const error = await failure(setup().service.create('u1', byQty(quantity)));
      expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: 50, max: 1000 }]);
    }
    await expect(setup().service.create('u1', byQty(50))).resolves.toBeDefined();
    await expect(setup().service.create('u1', byQty(1000))).resolves.toBeDefined();
  });

  it('custom quantity on a fixed-pack product is QTY_OUT_OF_RANGE with null bounds', async () => {
    const fixed = setup(product({ allowCustomQty: false, minQty: null, maxQty: null }));
    const error = await failure(fixed.service.create('u1', byQty(60)));
    expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: null, max: null }]);
    const noRange = setup(product({ allowCustomQty: true, minQty: null, maxQty: null }));
    expect((await failure(noRange.service.create('u1', byQty(60)))).code).toBe('QTY_OUT_OF_RANGE');
  });

  it('a quantity below the smallest active pack is QTY_OUT_OF_RANGE with the effective range', async () => {
    const { service, priceBook } = setup(product({ minQty: 10 }));
    const error = await failure(service.create('u1', byQty(20)));
    expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: 50, max: 1000 }]);
    expect(priceBook.price).not.toHaveBeenCalled();
  });

  it('an unusable recipient token is RECIPIENT_INVALID before pricing', async () => {
    const { service, tokens, priceBook, repository } = setup();
    tokens.resolve.mockResolvedValueOnce(null);
    const error = await failure(service.create('u1', bySku()));
    expect(error.code).toBe('RECIPIENT_INVALID');
    expect(tokens.resolve).toHaveBeenCalledWith(TOKEN, 'u1', 'p1');
    expect(priceBook.price).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('a discount code is CODE_INVALID until phase 10, after the recipient check', async () => {
    const { service, priceBook } = setup();
    const error = await failure(service.create('u1', bySku({ discountCode: 'SALE10' })));
    expect(error.code).toBe('CODE_INVALID');
    expect(priceBook.price).not.toHaveBeenCalled();

    const bad = setup();
    bad.tokens.resolve.mockResolvedValueOnce(null);
    expect((await failure(bad.service.create('u1', bySku({ discountCode: 'X' })))).code).toBe(
      'RECIPIENT_INVALID',
    );
  });

  it('a price book failure propagates and writes nothing', async () => {
    const { service, priceBook, repository } = setup();
    priceBook.price.mockRejectedValueOnce(new AppError('PRICE_UNAVAILABLE'));
    const error = await failure(service.create('u1', bySku()));
    expect(error.code).toBe('PRICE_UNAVAILABLE');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('the response has exactly the contract fields and no cost data', async () => {
    const { service } = setup();
    const out = await service.create('u1', bySku());
    expect(out).toEqual({
      quoteId: 'q1',
      priceTiyin: '550000',
      discountTiyin: '0',
      totalTiyin: '550000',
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      recipient: { username: 'aziz_k', displayName: 'Aziz' },
      currency: 'UZS',
    });
  });

  it('a custom quantity equal to an active pack is priced as that pack, like its skuId', async () => {
    const typed = setup();
    const out = await typed.service.create('u1', byQty(100));
    expect(typed.priceBook.price).toHaveBeenCalledWith({
      product: { id: 'p1', allowCustomQty: true },
      pricingSku: { id: 's100', quantity: 100, markupBps: 1100, minMarginTiyin: 100n },
      sku: { id: 's100' },
      quantity: 100,
      now: NOW,
    });
    expect(typed.repository.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ skuId: 's100', quantity: 100 }),
    );
    expect(out.quoteId).toBe('q1');
  });

  it('a quantity between two packs is still a custom quantity (sku null)', async () => {
    const { service, repository } = setup();
    await service.create('u1', byQty(101));
    expect(repository.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ skuId: null, quantity: 101 }),
    );
  });

  it('with the smallest pack deactivated the range starts at the next pack', async () => {
    const found = product({ minQty: 50 }, [sku('s100', 100), sku('s500', 500)]);
    const below = await failure(setup(found).service.create('u1', byQty(99)));
    expect([below.code, below.details]).toEqual(['QTY_OUT_OF_RANGE', { min: 100, max: 1000 }]);
    await expect(setup(found).service.create('u1', byQty(100))).resolves.toBeDefined();
  });

  describe('two active packs with the same quantity', () => {
    const duplicated = (): ReturnType<typeof product> =>
      product({}, [sku('s50', 50), sku('s100a', 100), sku('s100b', 100)]);

    it('closes custom quantity: QTY_OUT_OF_RANGE with null bounds, whatever the quantity', async () => {
      for (const quantity of [50, 99, 100, 101, 1000]) {
        const { service, priceBook, repository } = setup(duplicated());
        const error = await failure(service.create('u1', byQty(quantity)));
        expect([quantity, error.code, error.details]).toEqual([
          quantity,
          'QTY_OUT_OF_RANGE',
          { min: null, max: null },
        ]);
        expect(priceBook.price).not.toHaveBeenCalled();
        expect(repository.create).not.toHaveBeenCalled();
      }
    });

    it('does not depend on the row order', async () => {
      const reversed = product({}, [sku('s100b', 100), sku('s100a', 100), sku('s50', 50)]);
      const error = await failure(setup(reversed).service.create('u1', byQty(100)));
      expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: null, max: null }]);
    });

    it('selling either duplicate by skuId still works and prices that pack', async () => {
      for (const skuId of ['s100a', 's100b']) {
        const { service, priceBook } = setup(duplicated());
        await expect(service.create('u1', bySku({ skuId }))).resolves.toBeDefined();
        expect(priceBook.price).toHaveBeenCalledWith(
          expect.objectContaining({
            pricingSku: expect.objectContaining({ id: skuId }) as unknown,
            sku: { id: skuId },
            quantity: 100,
          }),
        );
      }
    });
  });

  it('no active pack at all: custom quantity is QTY_OUT_OF_RANGE with null bounds', async () => {
    const { service, priceBook } = setup(product({}, []));
    const error = await failure(service.create('u1', byQty(60)));
    expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: null, max: null }]);
    expect(priceBook.price).not.toHaveBeenCalled();
  });
});
