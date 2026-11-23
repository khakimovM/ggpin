import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** One category select for the list and for a catalog write's answer (S8a review m7). */
export const ADMIN_CATEGORY_SELECT = {
  id: true,
  slug: true,
  nameUz: true,
  nameRu: true,
  sort: true,
  _count: { select: { products: true } },
} as const satisfies Prisma.CategorySelect;
export type AdminCategorySource = Prisma.CategoryGetPayload<{
  select: typeof ADMIN_CATEGORY_SELECT;
}>;

export const ADMIN_SKU_SELECT = {
  id: true,
  tab: true,
  labelUz: true,
  labelRu: true,
  quantity: true,
  supplierSku: true,
  markupBps: true,
  minMarginTiyin: true,
  isActive: true,
  sort: true,
} as const satisfies Prisma.SkuSelect;

export const ADMIN_ROUTE_SELECT = {
  id: true,
  adapter: true,
  priority: true,
  isEnabled: true,
} as const satisfies Prisma.ProductRouteSelect;

/** A product row: never `inputSchema` (not editable in phase 9, D-63 (8)). */
export const ADMIN_PRODUCT_ROW_SELECT = {
  id: true,
  slug: true,
  categoryId: true,
  nameUz: true,
  nameRu: true,
  imageUrl: true,
  deliveryType: true,
  isActive: true,
  isFeatured: true,
  sort: true,
  _count: {
    select: { skus: { where: { isActive: true } }, routes: { where: { isEnabled: true } } },
  },
} as const satisfies Prisma.ProductSelect;
export type AdminProductRowSource = Prisma.ProductGetPayload<{
  select: typeof ADMIN_PRODUCT_ROW_SELECT;
}>;

export const ADMIN_PRODUCT_DETAIL_SELECT = {
  ...ADMIN_PRODUCT_ROW_SELECT,
  descriptionUz: true,
  descriptionRu: true,
  helpUz: true,
  helpRu: true,
  regionBadge: true,
  isAuto: true,
  allowCustomQty: true,
  minQty: true,
  maxQty: true,
  updatedAt: true,
  skus: {
    select: ADMIN_SKU_SELECT,
    orderBy: [{ sort: 'asc' }, { quantity: 'asc' }, { id: 'asc' }],
  },
  routes: { select: ADMIN_ROUTE_SELECT, orderBy: [{ priority: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.ProductSelect;
export type AdminProductDetailSource = Prisma.ProductGetPayload<{
  select: typeof ADMIN_PRODUCT_DETAIL_SELECT;
}>;

// The catalog as the panel reads it (all products, active or not). Writes are S8.
@Injectable()
export class AdminCatalogReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  categories(): Promise<AdminCategorySource[]> {
    return this.prisma.client.category.findMany({
      select: ADMIN_CATEGORY_SELECT,
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  }

  products(): Promise<AdminProductRowSource[]> {
    return this.prisma.client.product.findMany({
      select: ADMIN_PRODUCT_ROW_SELECT,
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  }

  product(id: string): Promise<AdminProductDetailSource | null> {
    return this.prisma.client.product.findUnique({
      where: { id },
      select: ADMIN_PRODUCT_DETAIL_SELECT,
    });
  }

  fxRate(id: string) {
    return this.prisma.client.fxRate.findUnique({
      where: { id },
      select: { id: true, pair: true, rate: true },
    });
  }
}
