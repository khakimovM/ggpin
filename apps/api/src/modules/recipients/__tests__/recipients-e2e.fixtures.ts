import type { PrismaService } from '../../../infra/prisma/prisma.service';

type Db = PrismaService['client'];

const TG_FORM = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];

export interface RecipientFixtures {
  /** Active Stars-like product with a 50 pack, a fresh cost and FX: it can be quoted. */
  readonly stars: { readonly id: string; readonly sku50: string };
  /** A second active product with the same form, to show a token is bound to its product. */
  readonly other: { readonly id: string; readonly sku50: string };
  readonly inactive: { readonly id: string };
  /** Active, but its form has no field: nothing to validate in this phase. */
  readonly noForm: { readonly id: string };
  readonly remove: () => Promise<void>;
}

// Numbers as in the quotes suite: TON_UZS 40 000, a 50 pack costs 125 000 000 nano, +10%.
export async function buildRecipientFixtures(
  db: Db,
  base: Date,
  sfx: string,
): Promise<RecipientFixtures> {
  const category = await db.category.create({
    data: { slug: `e2e-rcpt-${sfx}`, nameUz: 'Rcpt', nameRu: 'Rcpt', sort: 99 },
  });
  const product = (name: string, isActive: boolean, inputSchema: unknown[]) =>
    db.product.create({
      data: {
        slug: `e2e-rcpt-${name}-${sfx}`,
        categoryId: category.id,
        nameUz: name,
        nameRu: name,
        imageUrl: '/images/x.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: inputSchema as object[],
        isActive,
        allowCustomQty: false,
      },
    });
  const stars = await product('stars', true, TG_FORM);
  const other = await product('other', true, TG_FORM);
  const inactive = await product('inactive', false, TG_FORM);
  const noForm = await product('noform', true, []);
  const sku = await db.sku.create({
    data: {
      productId: stars.id,
      quantity: 50,
      labelUz: '50',
      labelRu: '50',
      markupBps: 1000,
      minMarginTiyin: 0n,
      isActive: true,
      sort: 50,
    },
  });
  const otherSku = await db.sku.create({
    data: { productId: other.id, quantity: 50, labelUz: '50', labelRu: '50', markupBps: 1000 },
  });
  const cost = await db.costSnapshot.create({
    data: {
      productId: stars.id,
      skuId: sku.id,
      adapter: 'FRAGMENT',
      currency: 'TON',
      basisQuantity: 50,
      costMinor: 125_000_000n,
      source: 'fixture',
      createdAt: base,
    },
  });
  const fx = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '40000', source: 'fixture', createdAt: base },
  });
  const productIds = [stars.id, other.id, inactive.id, noForm.id];

  return {
    stars: { id: stars.id, sku50: sku.id },
    other: { id: other.id, sku50: otherSku.id },
    inactive: { id: inactive.id },
    noForm: { id: noForm.id },
    remove: async () => {
      await db.costSnapshot.deleteMany({ where: { id: cost.id } });
      await db.fxRate.deleteMany({ where: { id: fx.id } });
      await db.sku.deleteMany({ where: { productId: { in: productIds } } });
      await db.product.deleteMany({ where: { id: { in: productIds } } });
      await db.category.deleteMany({ where: { id: category.id } });
    },
  };
}
