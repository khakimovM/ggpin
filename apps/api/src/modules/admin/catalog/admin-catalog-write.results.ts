import type {
  AdminCategoryUpdateResponseSchema,
  AdminProductDetailResponse,
  AdminProductReorderResponseSchema,
  AdminProductUpdateResponseSchema,
  AdminRouteUpdateResponseSchema,
  AdminSkuResponseSchema,
} from '@repo/shared';
import type { z } from 'zod';
import { AppError } from '../../../common/exceptions/app-error';
import type { Db } from '../../../infra/prisma/db';
import type {
  AdminCategorySource,
  AdminProductDetailSource,
} from './admin-catalog-read.repository';
import {
  toAdminCategory,
  toAdminProductDetail,
  toAdminRoute,
  toAdminSku,
} from './admin-catalog.mapper';
import type {
  AdminCatalogWriteRepository,
  AdminRouteSource,
  AdminSkuSource,
} from './admin-catalog-write.repository';

/** The answers of the six catalog writes (docs/04 «Katalog»), before the JSON envelope. */
export interface CatalogResults {
  readonly category: z.infer<typeof AdminCategoryUpdateResponseSchema>;
  readonly product: z.infer<typeof AdminProductUpdateResponseSchema>;
  readonly reorder: z.infer<typeof AdminProductReorderResponseSchema>;
  readonly sku: z.infer<typeof AdminSkuResponseSchema>;
  readonly route: z.infer<typeof AdminRouteUpdateResponseSchema>;
}

// The editable columns of each row, as the diff compares them (docs/04 «Katalog»: what PATCH may
// change). Named one by one: a column added later is never edited by accident.

export const categoryFields = (row: AdminCategorySource) => ({
  nameUz: row.nameUz,
  nameRu: row.nameRu,
  sort: row.sort,
});

export const productFields = (row: AdminProductDetailSource) => ({
  nameUz: row.nameUz,
  nameRu: row.nameRu,
  descriptionUz: row.descriptionUz,
  descriptionRu: row.descriptionRu,
  helpUz: row.helpUz,
  helpRu: row.helpRu,
  regionBadge: row.regionBadge,
  imageUrl: row.imageUrl,
  isActive: row.isActive,
  isFeatured: row.isFeatured,
  sort: row.sort,
});

export const skuFields = (row: AdminSkuSource) => ({
  tab: row.tab,
  labelUz: row.labelUz,
  labelRu: row.labelRu,
  quantity: row.quantity,
  supplierSku: row.supplierSku,
  markupBps: row.markupBps,
  minMarginTiyin: row.minMarginTiyin,
  isActive: row.isActive,
  sort: row.sort,
});

export const routeFields = (row: AdminRouteSource) => ({
  priority: row.priority,
  isEnabled: row.isEnabled,
});

/** What the builder reads (a slice of the repository: unit tests pass a plain fake). */
export type CatalogReadStore = Pick<AdminCatalogWriteRepository, 'category' | 'product'>;

/** Reads a row back through the catalog read mappers (the same shapes GET answers with). */
export class CatalogResultBuilder {
  constructor(private readonly repo: CatalogReadStore) {}

  async categorySource(db: Db, id: string): Promise<AdminCategorySource> {
    const row = await this.repo.category(db, id);
    if (row === null) throw new AppError('NOT_FOUND');
    return row;
  }

  async category(db: Db, id: string): Promise<CatalogResults['category']['category']> {
    return toAdminCategory(await this.categorySource(db, id));
  }

  async productSource(db: Db, id: string): Promise<AdminProductDetailSource> {
    const row = await this.repo.product(db, id);
    if (row === null) throw new AppError('NOT_FOUND');
    return row;
  }

  async product(db: Db, id: string): Promise<AdminProductDetailResponse> {
    return toAdminProductDetail(await this.productSource(db, id));
  }

  sku(row: AdminSkuSource): CatalogResults['sku']['sku'] {
    return toAdminSku(row);
  }

  route(row: AdminRouteSource): CatalogResults['route']['route'] {
    return toAdminRoute(row);
  }
}
