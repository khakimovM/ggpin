import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';

// Products, packs and routes the price-sync e2e suite runs against. They carry a per-run
// suffix and are removed afterwards; the suite runs through the e2e lock because the cost
// sync reads every product in the database.
const RUN = randomUUID().slice(0, 8);

export interface Fixtures {
  categoryId: string;
  starsId: string;
  premiumId: string;
  premiumSkus: Record<'m3' | 'm6' | 'm12', string>;
  inactiveId: string;
  otherRouteId: string;
}

export async function createFixtures(prisma: PrismaClient): Promise<Fixtures> {
  const category = await prisma.category.create({
    data: { slug: `e2e-ps-${RUN}`, nameUz: 'Test', nameRu: 'Тест' },
  });
  const product = (slug: string, extra: { isActive?: boolean; allowCustomQty?: boolean }) =>
    prisma.product.create({
      data: {
        slug: `e2e-ps-${slug}-${RUN}`,
        categoryId: category.id,
        nameUz: slug,
        nameRu: slug,
        imageUrl: '/e2e.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: [],
        isActive: extra.isActive ?? true,
        allowCustomQty: extra.allowCustomQty ?? false,
        ...(extra.allowCustomQty === true ? { minQty: 50, maxQty: 100_000 } : {}),
      },
    });
  const sku = async (productId: string, quantity: number, isActive = true) =>
    (
      await prisma.sku.create({
        data: {
          productId,
          labelUz: `${quantity}`,
          labelRu: `${quantity}`,
          quantity,
          markupBps: 1000,
          isActive,
        },
      })
    ).id;
  const route = (productId: string, adapter: string, priority: number, isEnabled = true) =>
    prisma.productRoute.create({ data: { productId, adapter, priority, isEnabled } });

  const stars = await product('stars', { allowCustomQty: true });
  await sku(stars.id, 50);
  await route(stars.id, 'FRAGMENT', 1);
  await route(stars.id, 'RESELLER_STARS', 2);

  const premium = await product('premium', {});
  const premiumSkus = {
    m3: await sku(premium.id, 3),
    m6: await sku(premium.id, 6),
    m12: await sku(premium.id, 12, false),
  };
  await route(premium.id, 'RESELLER_STARS', 1, false);
  await route(premium.id, 'FRAGMENT', 2);

  const inactive = await product('inactive', { isActive: false, allowCustomQty: true });
  await route(inactive.id, 'FRAGMENT', 1);

  const otherRoute = await product('other', { allowCustomQty: true });
  await route(otherRoute.id, 'RESELLER_STARS', 1);
  await route(otherRoute.id, 'FRAGMENT', 2);

  return {
    categoryId: category.id,
    starsId: stars.id,
    premiumId: premium.id,
    premiumSkus,
    inactiveId: inactive.id,
    otherRouteId: otherRoute.id,
  };
}

export async function deleteFixtures(prisma: PrismaClient, f: Fixtures): Promise<void> {
  const productId = { in: [f.starsId, f.premiumId, f.inactiveId, f.otherRouteId] };
  await prisma.costSnapshot.deleteMany({ where: { productId } });
  await prisma.productRoute.deleteMany({ where: { productId } });
  await prisma.sku.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.category.delete({ where: { id: f.categoryId } });
}
