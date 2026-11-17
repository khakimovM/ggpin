import { Inject, Injectable } from '@nestjs/common';
import {
  pricePreview,
  type AdminCategoryListResponse,
  type AdminPricePreviewQuery,
  type AdminPricePreviewResponse,
  type AdminProductDetailResponse,
  type AdminProductListResponse,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { PriceBookService } from '../../pricing/price-book.service';
import type { PricingSku } from '../../pricing/price-book.types';
import { customQtyRange, pickPricingSku } from '../../pricing/pricing-sku';
import { toAdminCategory, toAdminProductDetail, toAdminProductRow } from './admin-catalog.mapper';
import {
  AdminCatalogReadRepository,
  type AdminProductDetailSource,
} from './admin-catalog-read.repository';

interface Selection {
  readonly pricingSku: PricingSku;
  readonly sku: { readonly id: string } | null;
  readonly quantity: number;
}

const toPricingSku = (sku: AdminProductDetailSource['skus'][number]): PricingSku => ({
  id: sku.id,
  quantity: sku.quantity,
  markupBps: sku.markupBps,
  minMarginTiyin: sku.minMarginTiyin,
});

/**
 * An admin route refuses a domain value as `400 VALIDATION_ERROR` + `fields[{ path, code }]`
 * (docs/04 «Xatolar (admin)»), not the store's `422 QTY_OUT_OF_RANGE` (CR m3).
 */
export function qtyOutOfRange(): AppError {
  return new AppError('VALIDATION_ERROR', {
    fields: [{ path: 'quantity', code: 'QTY_OUT_OF_RANGE' }],
  });
}

/** The catalog for OWNER and OPERATOR (docs/04 «Katalog»), and the price a quote would lock now. */
@Injectable()
export class AdminCatalogReadService {
  constructor(
    private readonly repo: AdminCatalogReadRepository,
    private readonly priceBook: PriceBookService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async categories(): Promise<AdminCategoryListResponse> {
    return (await this.repo.categories()).map(toAdminCategory);
  }

  async products(): Promise<AdminProductListResponse> {
    return (await this.repo.products()).map(toAdminProductRow);
  }

  async product(id: string): Promise<AdminProductDetailResponse> {
    return toAdminProductDetail(await this.mustFind(id));
  }

  /**
   * The quote's own pricing path (PriceBookService: fresh cost snapshot and FX rate, simulated
   * data refused in production), with the proposed markup / minimum margin in place of the
   * stored ones. The margin comes from money-pricing.ts `pricePreview` on the same inputs; the
   * two prices must agree or nothing is shown.
   */
  async pricePreview(
    productId: string,
    query: AdminPricePreviewQuery,
  ): Promise<AdminPricePreviewResponse> {
    const product = await this.mustFind(productId);
    const chosen = this.select(product, query);
    const pricingSku: PricingSku = {
      ...chosen.pricingSku,
      markupBps: query.markupBps ?? chosen.pricingSku.markupBps,
      minMarginTiyin:
        query.minMarginTiyin === undefined
          ? chosen.pricingSku.minMarginTiyin
          : BigInt(query.minMarginTiyin),
    };
    const priced = await this.priceBook.price({
      product: { id: product.id, allowCustomQty: product.allowCustomQty },
      pricingSku,
      sku: chosen.sku,
      quantity: chosen.quantity,
      now: this.clock.now(),
    });
    const fx = await this.repo.fxRate(priced.fxRateId);
    if (fx === null) throw new AppError('PRICE_UNAVAILABLE');
    const preview = pricePreview({
      costMinor: priced.costMinor,
      costCurrency: priced.costCurrency,
      rate: fx.rate,
      markupBps: pricingSku.markupBps,
      minMarginTiyin: pricingSku.minMarginTiyin,
    });
    if (preview.priceTiyin !== priced.priceTiyin) throw new AppError('PRICE_UNAVAILABLE');
    return {
      costCurrency: priced.costCurrency,
      costMinor: priced.costMinor.toString(),
      fxRate: fx,
      markupBps: pricingSku.markupBps,
      minMarginTiyin: pricingSku.minMarginTiyin.toString(),
      priceTiyin: preview.priceTiyin.toString(),
      marginTiyin: preview.marginTiyin.toString(),
      belowMinMargin: preview.belowMinMargin,
    };
  }

  private async mustFind(id: string): Promise<AdminProductDetailSource> {
    const product = await this.repo.product(id);
    if (product === null) throw new AppError('NOT_FOUND');
    return product;
  }

  // Like the quote: a package of this product (an inactive one too: the owner previews before
  // switching it on), or a typed quantity inside the range the store would accept.
  private select(product: AdminProductDetailSource, query: AdminPricePreviewQuery): Selection {
    if (query.skuId !== undefined) {
      const sku = product.skus.find((candidate) => candidate.id === query.skuId);
      if (sku === undefined) throw new AppError('NOT_FOUND');
      return { pricingSku: toPricingSku(sku), sku: { id: sku.id }, quantity: sku.quantity };
    }
    const quantity = query.quantity ?? 0;
    const active = product.skus.filter((sku) => sku.isActive).map(toPricingSku);
    const range = customQtyRange(product, active);
    if (range === null || quantity < range.min || quantity > range.max) {
      throw qtyOutOfRange();
    }
    const exact = active.find((sku) => sku.quantity === quantity);
    if (exact !== undefined) return { pricingSku: exact, sku: { id: exact.id }, quantity };
    const pricingSku = pickPricingSku(active, quantity);
    if (pricingSku === null) throw qtyOutOfRange();
    return { pricingSku, sku: null, quantity };
  }
}
