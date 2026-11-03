import { Inject, Injectable } from '@nestjs/common';
import type {
  CatalogCategory,
  CatalogLocaleQuery,
  CatalogProductDetail,
  CatalogProductListItem,
  ProductListQuery,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { paginated, type WithMeta } from '../../common/http/with-meta';
import { PriceBookService } from '../pricing/price-book.service';
import type { DisplayProduct } from '../pricing/price-book.types';
import { CatalogRepository, type CatalogProductRow } from './catalog.repository';
import { toCategory, toDetail, toListItem } from './entities/catalog.mapper';

type Locale = CatalogLocaleQuery['locale'];

function toDisplayProduct(row: CatalogProductRow): DisplayProduct {
  return {
    id: row.id,
    skus: row.skus.map((sku) => ({
      id: sku.id,
      quantity: sku.quantity,
      markupBps: sku.markupBps,
      minMarginTiyin: sku.minMarginTiyin,
    })),
  };
}

// Public reads: no userId, nothing here is per user (the routes are publicly cacheable).
@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly priceBook: PriceBookService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async categories(locale: Locale): Promise<CatalogCategory[]> {
    const rows = await this.repository.listCategories();
    return rows.map((row) => toCategory(row, locale));
  }

  async products(query: ProductListQuery): Promise<WithMeta<readonly CatalogProductListItem[]>> {
    const { items, total } = await this.repository.listProducts({
      category: query.category,
      q: query.q,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const prices = await this.priceBook.displayPrices(
      items.map(toDisplayProduct),
      this.clock.now(),
    );
    const stock = await this.stockByProduct(items);
    return paginated(
      items.map((row) => {
        const count = stock.get(row.id);
        return toListItem(row, query.locale, prices.get(row.id), count === undefined || count > 0);
      }),
      { page: query.page, limit: query.limit, total },
    );
  }

  async product(slug: string, locale: Locale): Promise<CatalogProductDetail> {
    const row = await this.repository.findActiveBySlug(slug);
    if (row === null) throw new AppError('NOT_FOUND');
    const prices = await this.priceBook.displayPrices([toDisplayProduct(row)], this.clock.now());
    const stock = await this.stockByProduct([row]);
    return toDetail(row, locale, prices.get(row.id), stock.get(row.id) ?? null);
  }

  // Only voucher products have inventory; every other delivery type is unlimited (no entry).
  private async stockByProduct(rows: readonly CatalogProductRow[]): Promise<Map<string, number>> {
    const voucherRows = rows.filter((row) => row.deliveryType === 'VOUCHER');
    const perSku = await this.repository.availableVouchersBySku(
      voucherRows.flatMap((row) => row.skus.map((sku) => sku.id)),
    );
    return new Map(
      voucherRows.map((row) => [
        row.id,
        row.skus.reduce((sum, sku) => sum + (perSku.get(sku.id) ?? 0), 0),
      ]),
    );
  }
}
