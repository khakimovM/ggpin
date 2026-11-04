import type { Product, Quote, Sku } from '@repo/db';
import { QUOTE_TTL_MS, type CreateQuoteBody, type Recipient } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import type { FixedWindowCounter } from '../../../infra/redis/fixed-window-counter';
import type { PriceBookService } from '../../pricing/price-book.service';
import type { PriceResult } from '../../pricing/price-book.types';
import type { RecipientTokenStore } from '../../recipients/recipient-token.store';
import type { QuoteProduct, QuotesRepository } from '../quotes.repository';
import { QuotesService } from '../quotes.service';

export const NOW = new Date('2026-06-01T12:00:00.000Z');
export const TOKEN = 'T'.repeat(43);
export const RECIPIENT: Recipient = {
  username: 'aziz_k',
  displayName: 'Aziz',
  photoUrl: 'https://x.test/a.png',
};
export const PRICE: PriceResult = {
  costCurrency: 'TON',
  costMinor: 125_000_000n,
  costSnapshotId: 'cost_1',
  fxRateId: 'fx_1',
  priceTiyin: 550_000n,
  maxCostMinor: 128_750_000n,
};

export function sku(id: string, quantity: number): Sku {
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

export function product(
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

export function setup(found: QuoteProduct | null = product()) {
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

export const bySku = (over: Partial<CreateQuoteBody> = {}): CreateQuoteBody => ({
  productId: 'p1',
  skuId: 's50',
  recipientToken: TOKEN,
  ...over,
});
export const byQty = (quantity: number, over: Partial<CreateQuoteBody> = {}): CreateQuoteBody => ({
  productId: 'p1',
  quantity,
  recipientToken: TOKEN,
  ...over,
});

export async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}
