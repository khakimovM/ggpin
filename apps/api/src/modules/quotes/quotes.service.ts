import { Inject, Injectable } from '@nestjs/common';
import type { Sku } from '@repo/db';
import { QUOTE_TTL_MS, type CreateQuoteBody, type QuoteResponse } from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { FixedWindowCounter } from '../../infra/redis/fixed-window-counter';
import { PriceBookService } from '../pricing/price-book.service';
import type { PricingSku } from '../pricing/price-book.types';
import { pickPricingSku } from '../pricing/pricing-sku';
import { RecipientTokenStore } from '../recipients/recipient-token.store';
import { toQuoteResponse } from './entities/quote.mapper';
import { QuotesRepository, type QuoteProduct } from './quotes.repository';

/** Quotes per user per window. A real buyer needs a handful; a script needs thousands. */
export const QUOTE_LIMIT = { max: 30, windowSec: 60 } as const;

export const quoteLimitKey = (userId: string): string => `rl:quote:${userId}`;

interface Selection {
  readonly pricingSku: PricingSku;
  readonly sku: { readonly id: string } | null;
  readonly quantity: number;
}

function toPricingSku(sku: Sku): PricingSku {
  return {
    id: sku.id,
    quantity: sku.quantity,
    markupBps: sku.markupBps,
    minMarginTiyin: sku.minMarginTiyin,
  };
}

/**
 * Turns "this recipient, this pack/quantity" into a locked price for 10 minutes. A quote moves
 * no money: it only fixes the price (and the cost ceiling) that an order in phase 5 will honour,
 * so there is no idempotency key; `Order.quoteId` unique + `usedAt` stop a quote being spent
 * twice. Nothing is written unless every check and the price succeed.
 *
 * Redis outage: the limiter and the token store both throw, the caller gets a 500 and no quote
 * (fail closed: an unverifiable recipient is never accepted).
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly repository: QuotesRepository,
    private readonly priceBook: PriceBookService,
    private readonly tokens: RecipientTokenStore,
    private readonly counter: FixedWindowCounter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(userId: string, body: CreateQuoteBody): Promise<QuoteResponse> {
    await this.enforceLimit(userId);

    const product = await this.repository.findProductWithActiveSkus(body.productId);
    if (product === null) throw new AppError('NOT_FOUND');
    if (!product.isActive) throw new AppError('PRODUCT_UNAVAILABLE');

    const selection = this.select(product, body);

    // Same answer for unknown / expired / another user's / another product's token.
    const record = await this.tokens.resolve(body.recipientToken, userId, product.id);
    if (record === null) throw new AppError('RECIPIENT_INVALID');

    // Discount codes arrive in phase 10; until then any code is not a valid one.
    if (body.discountCode !== undefined) throw new AppError('CODE_INVALID');

    const now = this.clock.now();
    const price = await this.priceBook.price({
      product: { id: product.id },
      pricingSku: selection.pricingSku,
      sku: selection.sku,
      quantity: selection.quantity,
      now,
    });

    const quote = await this.repository.create(userId, {
      productId: product.id,
      skuId: selection.sku?.id ?? null,
      quantity: selection.quantity,
      recipient: record.recipient,
      costCurrency: price.costCurrency,
      costMinor: price.costMinor,
      fxRateId: price.fxRateId,
      costSnapshotId: price.costSnapshotId,
      priceTiyin: price.priceTiyin,
      maxCostMinor: price.maxCostMinor,
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    });
    return toQuoteResponse(quote);
  }

  private async enforceLimit(userId: string): Promise<void> {
    const hit = await this.counter.hit(quoteLimitKey(userId), QUOTE_LIMIT.windowSec);
    if (hit.count > QUOTE_LIMIT.max) {
      throw new AppError('RATE_LIMITED', undefined, { retryAfterSec: hit.ttlSec });
    }
  }

  // A pack must be an ACTIVE pack of this product. An unknown pack id of this product is
  // PRODUCT_UNAVAILABLE like an inactive one (the client cannot tell them apart and need not);
  // a `skuId` of another product is simply not among this product's packs.
  private select(product: QuoteProduct, body: CreateQuoteBody): Selection {
    if (body.skuId !== undefined) {
      const sku = product.skus.find((candidate) => candidate.id === body.skuId);
      if (sku === undefined) throw new AppError('PRODUCT_UNAVAILABLE');
      return { pricingSku: toPricingSku(sku), sku: { id: sku.id }, quantity: sku.quantity };
    }

    const { quantity } = body;
    const { allowCustomQty, minQty, maxQty } = product;
    // `null` bounds mean "no custom quantity for this product" (a fixed-pack product, or one
    // switched on without a range): clients get the same details shape either way.
    const customRange =
      allowCustomQty && minQty !== null && maxQty !== null ? { min: minQty, max: maxQty } : null;
    const outOfRange = (): AppError =>
      new AppError('QTY_OUT_OF_RANGE', customRange ?? { min: null, max: null });
    if (quantity === undefined || customRange === null) throw outOfRange();
    if (quantity < customRange.min || quantity > customRange.max) throw outOfRange();

    const pricingSku = pickPricingSku(product.skus.map(toPricingSku), quantity);
    if (pricingSku === null) throw outOfRange();
    return { pricingSku, sku: null, quantity };
  }
}
