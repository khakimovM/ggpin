import type { Product, Quote, Sku } from '@repo/db';
import { QUOTE_TTL_MS, type CreateQuoteBody, type Recipient } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import type { FixedWindowCounter } from '../../../infra/redis/fixed-window-counter';
import type { PriceBookService } from '../../pricing/price-book.service';
import type { PriceResult } from '../../pricing/price-book.types';
import type { RecipientTokenStore } from '../../recipients/recipient-token.store';
import { toQuoteResponse } from '../entities/quote.mapper';
import type { QuoteProduct, QuotesRepository } from '../quotes.repository';
import { QUOTE_LIMIT, QuotesService, quoteLimitKey } from '../quotes.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TOKEN = 'T'.repeat(43);
const RECIPIENT: Recipient = {
  username: 'aziz_k',
  displayName: 'Aziz',
  photoUrl: 'https://x.test/a.png',
};
const PRICE: PriceResult = {
  costCurrency: 'TON',
  costMinor: 125_000_000n,
  costSnapshotId: 'cost_1',
  fxRateId: 'fx_1',
  priceTiyin: 550_000n,
  maxCostMinor: 128_750_000n,
};

function sku(id: string, quantity: number): Sku {
  return {
    id,
    productId: 'p1',
    tab: null,
    labelUz: String(quantity),
    labelRu: String(quantity),
    quantity,
    supplierSku: null,
    markupBps: 1000 + quantity,
    minMarginTiyin: BigInt(quantity),
    isActive: true,
    sort: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function product(
  over: Partial<Product> = {},
  skus: Sku[] = [sku('s50', 50), sku('s100', 100)],
): QuoteProduct {
  return {
    id: 'p1',
    slug: 'stars',
    categoryId: 'c1',
    nameUz: 'Stars',
    nameRu: 'Stars',
    descriptionUz: null,
    descriptionRu: null,
    helpUz: null,
    helpRu: null,
    imageUrl: '/i.png',
    regionBadge: null,
    deliveryType: 'TG_USERNAME',
    inputSchema: [],
    isAuto: true,
    isFeatured: false,
    isActive: true,
    allowCustomQty: true,
    minQty: 50,
    maxQty: 1000,
    sort: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
    skus,
  };
}

function setup(found: QuoteProduct | null = product()) {
  const calls: string[] = [];
  const counter = {
    hit: jest.fn(() => {
      calls.push('limit');
      return Promise.resolve({ count: 1, ttlSec: 60 });
    }),
  };
  const repository = {
    findProductWithActiveSkus: jest.fn(() => {
      calls.push('product');
      return Promise.resolve(found);
    }),
    create: jest.fn((userId: string, data: { priceTiyin: bigint }) => {
      calls.push('insert');
      return Promise.resolve({
        id: 'q1',
        userId,
        recipient: { username: RECIPIENT.username, displayName: RECIPIENT.displayName },
        priceTiyin: data.priceTiyin,
        expiresAt: new Date(NOW.getTime() + QUOTE_TTL_MS),
      } as unknown as Quote);
    }),
  };
  const tokens = {
    resolve: jest.fn(() => {
      calls.push('token');
      return Promise.resolve({
        userId: 'u1',
        productId: 'p1',
        recipient: RECIPIENT,
        issuedAt: NOW.toISOString(),
      } as { userId: string; productId: string; recipient: Recipient; issuedAt: string } | null);
    }),
  };
  const priceBook = {
    price: jest.fn(() => {
      calls.push('price');
      return Promise.resolve(PRICE);
    }),
  };
  const service = new QuotesService(
    repository as unknown as QuotesRepository,
    priceBook as unknown as PriceBookService,
    tokens as unknown as RecipientTokenStore,
    counter as unknown as FixedWindowCounter,
    { now: () => NOW },
  );
  return { service, calls, counter, repository, tokens, priceBook };
}

const bySku = (over: Partial<CreateQuoteBody> = {}): CreateQuoteBody => ({
  productId: 'p1',
  skuId: 's50',
  recipientToken: TOKEN,
  ...over,
});
const byQty = (quantity: number, over: Partial<CreateQuoteBody> = {}): CreateQuoteBody => ({
  productId: 'p1',
  quantity,
  recipientToken: TOKEN,
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}

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
      product: { id: 'p1' },
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
      product: { id: 'p1' },
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

  it('a quantity below every active pack has no pricing SKU: QTY_OUT_OF_RANGE', async () => {
    const { service, priceBook } = setup(product({ minQty: 10 }));
    const error = await failure(service.create('u1', byQty(20)));
    expect([error.code, error.details]).toEqual(['QTY_OUT_OF_RANGE', { min: 10, max: 1000 }]);
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
});

describe('toQuoteResponse', () => {
  it('drops every cost-side column of the row, and the photo URL of the recipient', () => {
    const row = {
      id: 'q9',
      userId: 'u1',
      productId: 'p1',
      skuId: 's50',
      quantity: 50,
      recipient: { username: 'aziz_k', displayName: 'Aziz', photoUrl: 'https://x.test/a.png' },
      costCurrency: 'TON',
      costMinor: 1n,
      fxRateId: 'fx',
      costSnapshotId: 'snap',
      priceTiyin: 700_000n,
      maxCostMinor: 2n,
      discountCodeId: null,
      expiresAt: NOW,
      usedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as Quote;
    const out = toQuoteResponse(row);
    expect(Object.keys(out).sort()).toEqual([
      'currency',
      'discountTiyin',
      'expiresAt',
      'priceTiyin',
      'quoteId',
      'recipient',
      'totalTiyin',
    ]);
    expect(Object.keys(out.recipient).sort()).toEqual(['displayName', 'username']);
    expect(JSON.stringify(out)).not.toMatch(/snap|"fx"|maxCost|costMinor/);
  });
});
