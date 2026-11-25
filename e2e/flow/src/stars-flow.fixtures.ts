import { randomBytes } from 'node:crypto';
import { createPrismaClient } from '@repo/db';

// Phase 5 S11: a Telegram Stars product as the full flow needs it, made by this suite under its
// own slug (`flow-stars-<tag>`), so the seeded `telegram-stars` row of the shared `_test`
// database is never read or changed. The dry-run Fragment simulator prices a product by its
// shape (a custom-quantity product is Stars, per unit; p6 keeps any unknown slug as Stars too), so
// this product is a Stars product for the whole chain:
// - active, the seed's Telegram username form, a free quantity 50..100 000 with packs 50 and 100
//   (the 50 pack's 10 % markup prices a typed 75; minMarginTiyin 0 so the price is exact);
// - one enabled FRAGMENT route (the seed's order; no other route);
// - a fresh product-level FRAGMENT cost row of the SIMULATOR's per-Star price, so the worker's
//   re-quote equals the quote's cost, and a fresh TON_UZS rate.
// Afterwards the product and its packs are made inactive (never deleted: this suite's orders and
// quotes reference them, and cost / FX rows are immutable history).

const TG_FORM = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];
/** The simulated Fragment price of one Star (simulated-fragment-prices.ts), written out here. */
export const STAR_NANO = 4_700_000n;
/** A typed quantity that is no pack: the order has no SKU and the bot prints `× 75`. */
export const STARS_QTY = 75;
/** 75 x 0.0047 TON = 0.3525 TON. */
export const STARS_COST_NANO = STAR_NANO * BigInt(STARS_QTY);
/** 0.3525 TON x 40 000 so'm = 14 100 so'm; + 10 % markup = 15 510 so'm. */
export const STARS_PRICE = 1_551_000n;

export interface StarsFlowCatalog {
  readonly productId: string;
  /** The TON_UZS rate this suite wrote: every quote of the suite must be priced with it. */
  readonly fxRateId: string;
  readonly productName: { readonly uz: string; readonly ru: string };
  /** Makes the suite's product and packs inactive, then disconnects. */
  readonly restore: () => Promise<void>;
}

export async function starsFlowCatalog(databaseUrl: string): Promise<StarsFlowCatalog> {
  const db = createPrismaClient(databaseUrl);
  const tag = randomBytes(4).toString('hex');
  try {
    const category = await db.category.create({
      data: { slug: `flow-stars-cat-${tag}`, nameUz: 'Telegram', nameRu: 'Telegram' },
    });
    const product = await db.product.create({
      data: {
        slug: `flow-stars-${tag}`,
        categoryId: category.id,
        nameUz: 'Telegram Stars',
        nameRu: 'Telegram Stars',
        imageUrl: 'https://example.test/stars.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: TG_FORM,
        isActive: true,
        allowCustomQty: true,
        minQty: 50,
        maxQty: 100_000,
      },
    });
    for (const quantity of [50, 100]) {
      await db.sku.create({
        data: {
          productId: product.id,
          quantity,
          labelUz: `${String(quantity)} ⭐`,
          labelRu: `${String(quantity)} ⭐`,
          markupBps: 1000,
          minMarginTiyin: 0n,
          sort: quantity,
        },
      });
    }
    await db.productRoute.create({
      data: { productId: product.id, adapter: 'FRAGMENT', priority: 1 },
    });
    await db.costSnapshot.create({
      data: {
        productId: product.id,
        adapter: 'FRAGMENT',
        currency: 'TON',
        basisQuantity: 1,
        costMinor: STAR_NANO,
        source: 'stars-flow-e2e',
      },
    });
    const fx = await db.fxRate.create({
      data: { pair: 'TON_UZS', rate: '40000', source: 'stars-flow-e2e' },
    });
    return {
      productId: product.id,
      fxRateId: fx.id,
      productName: { uz: product.nameUz, ru: product.nameRu },
      restore: async () => {
        try {
          await db.sku.updateMany({ where: { productId: product.id }, data: { isActive: false } });
          await db.product.update({ where: { id: product.id }, data: { isActive: false } });
        } finally {
          await db.$disconnect();
        }
      },
    };
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
}
