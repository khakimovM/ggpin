// Create-only catalog seed: every row is looked up first and inserted only when missing, so a
// re-run never overwrites what an admin changed later (price margins, names, active flags).
import { ProductInputSchema } from '@repo/shared';
import type { Prisma, PrismaClient } from '../../src/index.js';
import { SEED_CATEGORIES, SEED_MARKUP_BPS, SEED_MIN_MARGIN_TIYIN } from './catalog-data.js';
import type { SeedCategory, SeedProduct } from './catalog-data.js';

export interface SeedOptions {
  /** false in production: products are created inactive until the owner enables them (Q18). */
  activateProducts: boolean;
}

export interface SeedReport {
  categories: number;
  products: number;
  routes: number;
  skus: number;
}

// Arbitrary constant: serialises concurrent seed runs so find-then-create cannot double-insert
// SKUs (Sku has no natural unique key to lean on).
const SEED_LOCK_KEY = 7_303_001;

async function seedProduct(
  tx: Prisma.TransactionClient,
  categoryId: string,
  product: SeedProduct,
  options: SeedOptions,
  report: SeedReport,
): Promise<void> {
  const inputSchema = ProductInputSchema.parse(product.inputSchema);

  let row = await tx.product.findUnique({ where: { slug: product.slug } });
  if (!row) {
    row = await tx.product.create({
      data: {
        slug: product.slug,
        categoryId,
        nameUz: product.nameUz,
        nameRu: product.nameRu,
        descriptionUz: product.descriptionUz,
        descriptionRu: product.descriptionRu,
        imageUrl: product.imageUrl,
        regionBadge: product.regionBadge,
        deliveryType: product.deliveryType,
        inputSchema,
        isAuto: true,
        isActive: options.activateProducts,
        allowCustomQty: product.allowCustomQty,
        minQty: product.minQty,
        maxQty: product.maxQty,
        sort: product.sort,
      },
    });
    report.products += 1;
  }

  for (const route of product.routes) {
    const existing = await tx.productRoute.findUnique({
      where: { productId_adapter: { productId: row.id, adapter: route.adapter } },
    });
    if (existing) continue;
    await tx.productRoute.create({ data: { productId: row.id, ...route } });
    report.routes += 1;
  }

  for (const [index, sku] of product.skus.entries()) {
    const existing = await tx.sku.findFirst({
      where: { productId: row.id, quantity: sku.quantity, tab: sku.tab },
    });
    if (existing) continue;
    await tx.sku.create({
      data: {
        productId: row.id,
        tab: sku.tab,
        labelUz: sku.labelUz,
        labelRu: sku.labelRu,
        quantity: sku.quantity,
        markupBps: SEED_MARKUP_BPS,
        minMarginTiyin: SEED_MIN_MARGIN_TIYIN,
        sort: index + 1,
      },
    });
    report.skus += 1;
  }
}

async function seedCategory(
  tx: Prisma.TransactionClient,
  category: SeedCategory,
  options: SeedOptions,
  report: SeedReport,
): Promise<void> {
  let row = await tx.category.findUnique({ where: { slug: category.slug } });
  if (!row) {
    row = await tx.category.create({
      data: {
        slug: category.slug,
        nameUz: category.nameUz,
        nameRu: category.nameRu,
        sort: category.sort,
      },
    });
    report.categories += 1;
  }
  for (const product of category.products) {
    await seedProduct(tx, row.id, product, options, report);
  }
}

/** Returns how many rows this run created (all zero on a re-run). */
export async function seedCatalog(db: PrismaClient, options: SeedOptions): Promise<SeedReport> {
  const report: SeedReport = { categories: 0, products: 0, routes: 0, skus: 0 };
  await db.$transaction(
    async (tx) => {
      // $executeRaw: the function returns void, which $queryRaw cannot deserialize.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY}::bigint)`;
      for (const category of SEED_CATEGORIES) {
        await seedCategory(tx, category, options, report);
      }
    },
    { timeout: 30_000 },
  );
  return report;
}
