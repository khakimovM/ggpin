import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  ADMIN_CATEGORY_SELECT,
  ADMIN_PRODUCT_DETAIL_SELECT,
  ADMIN_ROUTE_SELECT,
  ADMIN_SKU_SELECT,
  type AdminCategorySource,
  type AdminProductDetailSource,
} from './admin-catalog-read.repository';

export type AdminSkuSource = Prisma.SkuGetPayload<{ select: typeof ADMIN_SKU_SELECT }>;
export type AdminRouteSource = Prisma.ProductRouteGetPayload<{
  select: typeof ADMIN_ROUTE_SELECT;
}>;

/** What the package rules need of the locked product (never `inputSchema`). */
export interface LockedProduct {
  readonly id: string;
  readonly slug: string;
  readonly allowCustomQty: boolean;
  /** The free-quantity range (null on a fixed-pack product): a package stays inside it. */
  readonly minQty: number | null;
  readonly maxQty: number | null;
}

export interface CatalogAudit {
  readonly id: string;
  readonly actorId: string;
  readonly ip: string | null;
  readonly action: string;
  readonly targetType: 'Category' | 'Product' | 'Sku' | 'ProductRoute' | 'Catalog';
  readonly targetId: string;
  readonly before: Prisma.InputJsonValue;
  readonly after: Prisma.InputJsonValue;
  readonly reason: string | undefined;
}

export type CategoryData = Prisma.CategoryUpdateInput;
export type ProductData = Prisma.ProductUpdateInput;
export type SkuUpdateData = Prisma.SkuUpdateInput;
export type RouteData = Prisma.ProductRouteUpdateInput;
export type SkuCreateData = Omit<Prisma.SkuUncheckedCreateInput, 'id' | 'productId'>;

/**
 * Writes of the admin catalog (docs/04 «Katalog», plan S8a). Every write locks first: the
 * Category row for a category, the Product row for the product itself, its packages and its
 * routes, every Product row (id order) for a reorder.
 *
 * The locks are `FOR NO KEY UPDATE` (review M2, precedent `audit-actor.repository.ts`): no
 * catalog write changes a key column, and a plain `FOR UPDATE` would conflict with the
 * `FOR KEY SHARE` lock that Postgres takes on the referenced row for every foreign-key INSERT.
 * A quote, an order or a cost snapshot of this product (or a product of this category) would
 * then wait for the admin's transaction. With `NO KEY UPDATE` those inserts go on; two catalog
 * writes of one row still exclude each other, which is all the package rules need.
 */
@Injectable()
export class AdminCatalogWriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /** The root client, for a replay's read outside any transaction. */
  client(): Db {
    return this.prisma.client;
  }

  async lockCategory(tx: Db, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Category" WHERE "id" = ${id} FOR NO KEY UPDATE`;
    return rows.length === 1;
  }

  async lockProduct(tx: Db, id: string): Promise<LockedProduct | null> {
    const rows = await tx.$queryRaw<LockedProduct[]>`
      SELECT "id", "slug", "allowCustomQty", "minQty", "maxQty" FROM "Product"
      WHERE "id" = ${id} FOR NO KEY UPDATE`;
    return rows[0] ?? null;
  }

  /** Every product, locked in id order (one order for every reorder: no deadlock between two). */
  async lockAllProducts(tx: Db): Promise<{ id: string; sort: number }[]> {
    return tx.$queryRaw<{ id: string; sort: number }[]>`
      SELECT "id", "sort" FROM "Product" ORDER BY "id" FOR NO KEY UPDATE`;
  }

  /** The product a package belongs to (unlocked: the caller locks it, then re-reads the package). */
  async skuProductId(db: Db, skuId: string): Promise<string | null> {
    const row = await db.sku.findUnique({ where: { id: skuId }, select: { productId: true } });
    return row?.productId ?? null;
  }

  async routeProductId(db: Db, routeId: string): Promise<string | null> {
    const row = await db.productRoute.findUnique({
      where: { id: routeId },
      select: { productId: true },
    });
    return row?.productId ?? null;
  }

  category(db: Db, id: string): Promise<AdminCategorySource | null> {
    return db.category.findUnique({ where: { id }, select: ADMIN_CATEGORY_SELECT });
  }

  product(db: Db, id: string): Promise<AdminProductDetailSource | null> {
    return db.product.findUnique({ where: { id }, select: ADMIN_PRODUCT_DETAIL_SELECT });
  }

  /** A package of THIS product (another product's id is not found). */
  sku(db: Db, productId: string, skuId: string): Promise<AdminSkuSource | null> {
    return db.sku.findFirst({ where: { id: skuId, productId }, select: ADMIN_SKU_SELECT });
  }

  route(db: Db, productId: string, routeId: string): Promise<AdminRouteSource | null> {
    return db.productRoute.findFirst({
      where: { id: routeId, productId },
      select: ADMIN_ROUTE_SELECT,
    });
  }

  /** Active packages of the product with this quantity, other than `exceptSkuId`. */
  activeSkusWithQuantity(
    tx: Db,
    productId: string,
    quantity: number,
    exceptSkuId: string | null,
  ): Promise<number> {
    return tx.sku.count({
      where: {
        productId,
        quantity,
        isActive: true,
        ...(exceptSkuId === null ? {} : { id: { not: exceptSkuId } }),
      },
    });
  }

  async updateCategory(tx: Db, id: string, data: CategoryData): Promise<void> {
    await tx.category.update({ where: { id }, data, select: { id: true } });
  }

  async updateProduct(tx: Db, id: string, data: ProductData): Promise<void> {
    await tx.product.update({ where: { id }, data, select: { id: true } });
  }

  async createSku(tx: Db, productId: string, data: SkuCreateData): Promise<AdminSkuSource> {
    return tx.sku.create({ data: { ...data, productId }, select: ADMIN_SKU_SELECT });
  }

  async updateSku(tx: Db, id: string, data: SkuUpdateData): Promise<void> {
    await tx.sku.update({ where: { id }, data, select: { id: true } });
  }

  async updateRoute(tx: Db, id: string, data: RouteData): Promise<void> {
    await tx.productRoute.update({ where: { id }, data, select: { id: true } });
  }

  async setSort(tx: Db, id: string, sort: number): Promise<void> {
    await tx.product.update({ where: { id }, data: { sort }, select: { id: true } });
  }

  /** Current sort of the given products (a reorder replay answers with the state now). */
  sorts(db: Db, ids: readonly string[]): Promise<{ id: string; sort: number }[]> {
    return db.product.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, sort: true },
    });
  }

  async createAudit(tx: Db, data: CatalogAudit): Promise<void> {
    await tx.auditLog.create({
      data: {
        id: data.id,
        actorType: 'ADMIN',
        actorId: data.actorId,
        ip: data.ip,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId,
        before: data.before,
        after: data.after,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
      },
      select: { id: true },
    });
  }
}

/**
 * What the write service uses (a slice of the repository). The service injects the class token
 * but types it as this slice, so the unit tests pass a plain fake without casts (the
 * pricing-sync `FxRateStore` pattern, S8a review m8).
 */
export type CatalogWriteStore = Pick<
  AdminCatalogWriteRepository,
  | 'transaction'
  | 'lockCategory'
  | 'lockProduct'
  | 'lockAllProducts'
  | 'skuProductId'
  | 'routeProductId'
  | 'category'
  | 'product'
  | 'sku'
  | 'route'
  | 'activeSkusWithQuantity'
  | 'updateCategory'
  | 'updateProduct'
  | 'createSku'
  | 'updateSku'
  | 'updateRoute'
  | 'setSort'
  | 'createAudit'
>;
