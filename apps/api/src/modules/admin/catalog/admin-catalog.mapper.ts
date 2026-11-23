import type {
  AdminCategoryListResponse,
  AdminProductDetailResponse,
  AdminProductListResponse,
} from '@repo/shared';
import { iso } from '../read/admin-read-view';
import type {
  AdminCategorySource,
  AdminProductDetailSource,
  AdminProductRowSource,
} from './admin-catalog-read.repository';

type Sku = AdminProductDetailResponse['skus'][number];
type Route = AdminProductDetailResponse['routes'][number];

// Every field is named (SA-S4-4): a column added to a select later never rides along into a
// response by a spread; the strict shared schemas then catch anything the mapper forgot.

export function toAdminCategory(category: AdminCategorySource): AdminCategoryListResponse[number] {
  return {
    id: category.id,
    slug: category.slug,
    nameUz: category.nameUz,
    nameRu: category.nameRu,
    sort: category.sort,
    productsCount: category._count.products,
  };
}

export function toAdminProductRow(
  product: AdminProductRowSource,
): AdminProductListResponse[number] {
  return {
    id: product.id,
    slug: product.slug,
    categoryId: product.categoryId,
    nameUz: product.nameUz,
    nameRu: product.nameRu,
    imageUrl: product.imageUrl,
    deliveryType: product.deliveryType,
    isActive: product.isActive,
    isFeatured: product.isFeatured,
    sort: product.sort,
    activeSkusCount: product._count.skus,
    routesEnabledCount: product._count.routes,
  };
}

export const toAdminSku = (sku: AdminProductDetailSource['skus'][number]): Sku => ({
  id: sku.id,
  tab: sku.tab,
  labelUz: sku.labelUz,
  labelRu: sku.labelRu,
  quantity: sku.quantity,
  supplierSku: sku.supplierSku,
  markupBps: sku.markupBps,
  minMarginTiyin: sku.minMarginTiyin.toString(),
  isActive: sku.isActive,
  sort: sku.sort,
});

/**
 * Route health comes from the adapter health key the phase 5 worker writes; until the panel
 * reads it (9-B, S11) every route is UNKNOWN with no check time.
 */
export const toAdminRoute = (route: AdminProductDetailSource['routes'][number]): Route => ({
  id: route.id,
  adapter: route.adapter,
  priority: route.priority,
  isEnabled: route.isEnabled,
  health: 'UNKNOWN',
  healthCheckedAt: null,
});

export function toAdminProductDetail(
  product: AdminProductDetailSource,
): AdminProductDetailResponse {
  return {
    ...toAdminProductRow(product),
    descriptionUz: product.descriptionUz,
    descriptionRu: product.descriptionRu,
    helpUz: product.helpUz,
    helpRu: product.helpRu,
    regionBadge: product.regionBadge,
    isAuto: product.isAuto,
    allowCustomQty: product.allowCustomQty,
    minQty: product.minQty,
    maxQty: product.maxQty,
    skus: product.skus.map(toAdminSku),
    routes: product.routes.map(toAdminRoute),
    updatedAt: iso(product.updatedAt),
  };
}
