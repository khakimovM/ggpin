import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import {
  COST_CURRENCIES,
  COST_FX_PAIR,
  costForQuantity,
  maxCostFor,
  priceFromCost,
  type CostCurrency,
} from '@repo/shared';
import { RESELLER_STARS_ADAPTER } from '../../adapters/simulator/simulated-reseller.adapter';

// Criterion 5 end to end (phase 5 S7 review M2): a Stars product priced by the REAL cost sync and
// an order made from that price the way the API makes one, as close as a worker e2e can get
// without the API process. What is the API's own code and what is assumed here:
//
// - the snapshot: the newest product-level CostSnapshot of the product, like the API's
//   PricingRepository.latestCostSnapshot (any adapter: the API never filters by adapter);
// - cost, price and ceiling: the same @repo/shared functions PriceBookService.price calls
//   (costForQuantity, priceFromCost, maxCostFor) on the newest FX rate of COST_FX_PAIR;
// - ASSUMED (no Sku row, the API's config is not loaded here): markupBps, minMarginTiyin and
//   toleranceBps below (the API's PRICE_TOLERANCE_BPS default is 300), and the freshness checks
//   (the rows were written moments ago by the syncs);
// - the quote + PAID order + PURCHASE debit are written like POST /orders does (S2), as
//   fulfill-e2e.fixtures.ts does, with the snapshot's currency, cost and ceiling.

const MARKUP_BPS = 1_000;
const MIN_MARGIN_TIYIN = 100_000n;
const TOLERANCE_BPS = 300;

const tag = (): string => `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

/** An ACTIVE custom-quantity (Stars-like) product routed FRAGMENT first, RESELLER_STARS second. */
export async function starsProduct(db: PrismaClient): Promise<{ id: string; slug: string }> {
  const t = tag();
  const category = await db.category.create({
    data: { slug: `fo-cat-${t}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
  });
  const product = await db.product.create({
    data: {
      slug: `fo-stars-${t}`,
      categoryId: category.id,
      nameUz: 'Yulduzlar',
      nameRu: 'Звёзды',
      imageUrl: 'https://example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [],
      allowCustomQty: true,
      minQty: 50,
      maxQty: 10_000,
      isActive: true,
    },
    select: { id: true, slug: true },
  });
  await db.productRoute.createMany({
    data: [
      { productId: product.id, adapter: 'FRAGMENT', priority: 1 },
      { productId: product.id, adapter: RESELLER_STARS_ADAPTER, priority: 2 },
    ],
  });
  return product;
}

export interface QuotedOrder {
  readonly orderId: string;
  readonly costCurrency: CostCurrency;
  readonly snapshotAdapter: string;
}

function currencyOf(text: string): CostCurrency {
  const currency = COST_CURRENCIES.find((c) => c === text);
  if (currency === undefined) throw new Error(`unknown cost currency ${text}`);
  return currency;
}

/** A PAID order for `quantity` units at the product's newest price (see above). */
export async function orderAtCurrentPrice(
  db: PrismaClient,
  input: {
    readonly productId: string;
    readonly quantity: number;
    readonly recipient: Readonly<Record<string, string>>;
    readonly providerRef: string;
  },
): Promise<QuotedOrder> {
  const snapshot = await db.costSnapshot.findFirstOrThrow({
    where: { productId: input.productId, skuId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const costCurrency = currencyOf(snapshot.currency);
  const fx = await db.fxRate.findFirstOrThrow({
    where: { pair: COST_FX_PAIR[costCurrency] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const costMinor = costForQuantity({
    snapshotCostMinor: snapshot.costMinor,
    basisQuantity: snapshot.basisQuantity,
    quantity: input.quantity,
    scope: 'product',
  });
  const { priceTiyin } = priceFromCost({
    costMinor,
    costCurrency,
    rate: fx.rate,
    markupBps: MARKUP_BPS,
    minMarginTiyin: MIN_MARGIN_TIYIN,
  });
  const maxCostMinor = maxCostFor({
    costMinor,
    costCurrency,
    rate: fx.rate,
    priceTiyin,
    discountTiyin: 0n,
    minMarginTiyin: MIN_MARGIN_TIYIN,
    toleranceBps: TOLERANCE_BPS,
  });
  const t = tag();
  const user = await db.user.create({
    data: {
      telegramId: BigInt(
        `7${String(Date.now()).slice(-9)}${String(randomBytes(2).readUInt16BE(0))}`,
      ),
      referralCode: `fo${t}`,
    },
  });
  await db.wallet.create({ data: { userId: user.id } });
  const common = {
    userId: user.id,
    productId: input.productId,
    quantity: input.quantity,
    recipient: { ...input.recipient },
    providerRef: input.providerRef,
    costCurrency,
    costMinor,
    fxRateId: fx.id,
    priceTiyin,
    maxCostMinor,
  };
  const quote = await db.quote.create({
    data: { ...common, costSnapshotId: snapshot.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  const order = await db.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        ...common,
        quoteId: quote.id,
        status: 'PAID',
        idempotencyKey: `key-${t}`,
        requestHash: 'hash-a',
      },
    });
    await tx.ledgerEntry.create({
      data: {
        userId: created.userId,
        kind: 'PURCHASE',
        amountTiyin: -(created.priceTiyin - created.discountTiyin),
        refType: 'ORDER',
        refId: created.id,
      },
    });
    return created;
  });
  return { orderId: order.id, costCurrency, snapshotAdapter: snapshot.adapter };
}
