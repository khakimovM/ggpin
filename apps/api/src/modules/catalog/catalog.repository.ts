import { Injectable } from '@nestjs/common';
import type { Category, Prisma } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Hard cap on categories: the endpoint is not paginated (docs/04). */
export const CATEGORY_LIMIT = 100;

export type CategoryWithCount = Category & { readonly activeProductCount: number };

const PRODUCT_INCLUDE = {
  category: { select: { slug: true } },
  skus: { where: { isActive: true }, orderBy: [{ quantity: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ProductInclude;

export type CatalogProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

export interface ProductListFilter {
  readonly category?: string;
  readonly q?: string;
  readonly skip: number;
  readonly take: number;
}

/**
 * Prisma's `contains` does not escape LIKE wildcards: `q=%` would match every row and `q=_`
 * every non-empty name. Escape with the Postgres default escape character (backslash).
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Public catalog reads. Active products only: an inactive product does not exist for callers,
// on the list and on the detail alike.
@Injectable()
export class CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(): Promise<CategoryWithCount[]> {
    const rows = await this.prisma.client.category.findMany({
      where: { products: { some: { isActive: true } } },
      orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
      take: CATEGORY_LIMIT,
      include: { _count: { select: { products: { where: { isActive: true } } } } },
    });
    return rows.map(({ _count, ...category }) => ({
      ...category,
      activeProductCount: _count.products,
    }));
  }

  async listProducts(
    filter: ProductListFilter,
  ): Promise<{ items: CatalogProductRow[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(filter.category === undefined ? {} : { category: { slug: filter.category } }),
      ...(filter.q === undefined
        ? {}
        : {
            OR: [
              { nameUz: { contains: escapeLike(filter.q), mode: 'insensitive' } },
              { nameRu: { contains: escapeLike(filter.q), mode: 'insensitive' } },
            ],
          }),
    };
    const [items, total] = await this.prisma.client.$transaction([
      this.prisma.client.product.findMany({
        where,
        orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
        skip: filter.skip,
        take: filter.take,
        include: PRODUCT_INCLUDE,
      }),
      this.prisma.client.product.count({ where }),
    ]);
    return { items, total };
  }

  findActiveBySlug(slug: string): Promise<CatalogProductRow | null> {
    return this.prisma.client.product.findFirst({
      where: { slug, isActive: true },
      include: PRODUCT_INCLUDE,
    });
  }

  /** AVAILABLE voucher count per SKU, only for the given SKUs (voucher products). */
  async availableVouchersBySku(skuIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (skuIds.length === 0) return new Map();
    const rows = await this.prisma.client.voucher.groupBy({
      by: ['skuId'],
      where: { skuId: { in: [...skuIds] }, status: 'AVAILABLE' },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.skuId, row._count._all]));
  }
}
