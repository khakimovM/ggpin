import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { FRAGMENT_PRODUCT_SLUGS, type PremiumMonths } from '@repo/shared';
import { namespacedProviderRef } from '../../adapters/provider-ref';
import type { PrepareContext, PrepareResult } from '../../adapters/fulfillment-adapter';
import { SimulatedFragmentAdapter } from '../../adapters/simulator/simulated-fragment.adapter';
import {
  simulatedProviderRef,
  type SimulatorScript,
} from '../../adapters/simulator/simulator-script';
import type { Env } from '../../config/env';
import type { OrderFixture } from './fulfill-e2e.fixtures';

// Phase 6 S2: Telegram Premium orders for the fulfill-order e2e. The simulator decides the product
// kind by the EXACT slug (fragmentProductKind, owner Q4), so these orders belong to a product whose
// slug is `telegram-premium`. The slug is unique and orders keep a product forever (FK, append-only
// attempts and transfers), so the product is found or created ONCE under an advisory lock and
// then reused by every run and suite; an existing one (a seeded catalog) is only read, never
// changed: what it lacks is added (a 3/6/12 SKU, the FRAGMENT route), nothing it has is updated.
// Adding a missing SKU to an existing product is accepted (CR m3): this runs on a `_test` DB only.
// A route the fixture cannot vouch for (FRAGMENT disabled, any other adapter enabled) stops it.
// Orders are born PAID with their PURCHASE debit in one transaction, as in fulfill-e2e.fixtures.

let counter = 0;
const tag = (): string =>
  `${Date.now().toString(36)}${(++counter).toString(36)}${randomBytes(3).toString('hex')}`;

/**
 * The simulated Fragment price of each Premium term (nanotons), written out here on purpose and
 * NOT read from simulated-fragment-prices.ts: a simulator that priced a term from another row
 * must fail these tests, not move the expectation with it.
 */
export const PREMIUM_NANO: Readonly<Record<PremiumMonths, bigint>> = {
  3: 3_750_000_000n,
  6: 5_000_000_000n,
  12: 9_100_000_000n,
};

/** The fixture's TON_UZS rate ('30000.5' so'm per TON) in tiyin per TON, exact. */
const FX_RATE = '30000.5';
const TIYIN_PER_TON = 3_000_050n;
const NANO_PER_TON = 1_000_000_000n;

/**
 * A realistic customer price of a term (CR m4): the cost at the fixture's rate plus 10 %, rounded UP
 * to a whole so'm, so a fixture order is never sold at a loss (3 months: 12 375 300 tiyin).
 */
export function premiumPriceTiyin(months: PremiumMonths): bigint {
  const scaled = PREMIUM_NANO[months] * TIYIN_PER_TON * 110n;
  const divisor = NANO_PER_TON * 100n * 100n;
  const som = (scaled + divisor - 1n) / divisor;
  return som * 100n;
}

export interface PremiumCatalog {
  readonly productId: string;
  readonly skuIds: Readonly<Record<PremiumMonths, string>>;
}

export interface PremiumOrderFixture extends OrderFixture {
  readonly months: PremiumMonths;
  readonly skuId: string;
  /** The quote's cost (the simulated price of this term) and its stored ceiling (+10 %). */
  readonly costNano: bigint;
  readonly maxCostNano: bigint;
  /** What the customer paid (the PURCHASE debit is minus this). */
  readonly priceTiyin: bigint;
}

const LOCK_KEY = 'ggpin:e2e:telegram-premium-fixture';

/** The `telegram-premium` product with an active 3/6/12 month SKU each and a FRAGMENT route. */
export async function premiumCatalog(db: PrismaClient): Promise<PremiumCatalog> {
  return db.$transaction(async (tx) => {
    // Two suites (or an API e2e) creating the unique slug at once: one waits for the other.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
    const slug = FRAGMENT_PRODUCT_SLUGS.PREMIUM;
    let product = await tx.product.findUnique({ where: { slug }, select: { id: true } });
    if (product === null) {
      const category = await tx.category.create({
        data: { slug: `ful-prem-cat-${tag()}`, nameUz: 'Telegram', nameRu: 'Telegram' },
      });
      product = await tx.product.create({
        data: {
          slug,
          categoryId: category.id,
          nameUz: 'Telegram Premium',
          nameRu: 'Telegram Premium',
          imageUrl: 'https://example.test/premium.png',
          deliveryType: 'TG_USERNAME',
          inputSchema: [],
          allowCustomQty: false,
        },
        select: { id: true },
      });
    }
    const productId = product.id;
    const route = await tx.productRoute.findUnique({
      where: { productId_adapter: { productId, adapter: 'FRAGMENT' } },
    });
    if (route === null) {
      await tx.productRoute.create({ data: { productId, adapter: 'FRAGMENT', priority: 1 } });
    } else if (!route.isEnabled) {
      throw new Error('telegram-premium has a disabled FRAGMENT route: not changed by a test');
    }
    const others = await tx.productRoute.findMany({
      where: { productId, isEnabled: true, adapter: { not: 'FRAGMENT' } },
      select: { adapter: true },
    });
    if (others.length > 0) {
      const names = others.map((r) => r.adapter).join(', ');
      throw new Error(
        `telegram-premium has other enabled routes (${names}): not changed by a test`,
      );
    }
    const skuOf = async (months: PremiumMonths): Promise<string> => {
      const found = await tx.sku.findFirst({
        where: { productId, quantity: months, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const sku =
        found ??
        (await tx.sku.create({
          data: {
            productId,
            quantity: months,
            labelUz: `${String(months)} oylik`,
            labelRu: `${String(months)} мес.`,
            markupBps: 1000,
          },
          select: { id: true },
        }));
      return sku.id;
    };
    const skuIds = {
      3: await skuOf(3),
      6: await skuOf(6),
      12: await skuOf(12),
    } satisfies Record<PremiumMonths, string>;
    return { productId, skuIds };
  });
}

/** A PAID Premium order of a new user for `months`, priced at the simulated cost of that term. */
export async function premiumOrder(
  db: PrismaClient,
  months: PremiumMonths,
): Promise<PremiumOrderFixture> {
  const catalog = await premiumCatalog(db);
  const skuId = catalog.skuIds[months];
  const t = tag();
  const username = `prem${t}`.slice(0, 32);
  const costNano = PREMIUM_NANO[months];
  const maxCostNano = (costNano * 110n) / 100n;
  const priceTiyin = premiumPriceTiyin(months);
  // Never a loss: the price covers the cost at the fixture's rate (rounded up).
  if (priceTiyin * NANO_PER_TON < costNano * TIYIN_PER_TON) {
    throw new Error('the fixture price is below the cost');
  }
  const user = await db.user.create({
    data: {
      telegramId: BigInt(`6${String(Date.now()).slice(-9)}${String(counter)}`),
      referralCode: `prm${t}`,
    },
  });
  // The wallet row every user gets at sign-up: the refund path locks it (rules/20).
  await db.wallet.create({ data: { userId: user.id } });
  const fxRate = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: FX_RATE, source: 'fulfill-premium-e2e' },
  });
  const costSnapshot = await db.costSnapshot.create({
    data: {
      productId: catalog.productId,
      skuId,
      adapter: 'FRAGMENT',
      currency: 'TON',
      basisQuantity: months,
      costMinor: costNano,
      source: 'fulfill-premium-e2e',
    },
  });
  const common = {
    userId: user.id,
    productId: catalog.productId,
    skuId,
    quantity: months,
    recipient: { username, displayName: username },
    providerRef: namespacedProviderRef('FRAGMENT', simulatedProviderRef(username)),
    costCurrency: 'TON',
    costMinor: costNano,
    fxRateId: fxRate.id,
    priceTiyin,
    maxCostMinor: maxCostNano,
  } as const;
  const quote = await db.quote.create({
    data: { ...common, costSnapshotId: costSnapshot.id, expiresAt: new Date(Date.now() + 600_000) },
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
  return {
    userId: user.id,
    orderId: order.id,
    productId: catalog.productId,
    months,
    skuId,
    costNano,
    maxCostNano,
    priceTiyin,
  };
}

/** The simulated Fragment adapter, recording what the fulfillment core hands to `prepare`. */
export class RecordingFragment extends SimulatedFragmentAdapter {
  readonly seen: PrepareContext[] = [];

  constructor(env: Env, script: SimulatorScript) {
    super(env, script);
  }

  override prepare(context: PrepareContext): Promise<PrepareResult> {
    this.seen.push(context);
    return super.prepare(context);
  }
}

/** The TON amount an attempt's `request` instructs (nanotons), or null. */
export function requestedNano(request: unknown): bigint | null {
  if (typeof request !== 'object' || request === null) return null;
  const ton: unknown = Reflect.get(request, 'ton');
  if (typeof ton !== 'object' || ton === null) return null;
  const amount: unknown = Reflect.get(ton, 'amountNano');
  return typeof amount === 'string' ? BigInt(amount) : null;
}

/** The TON payee an attempt's `request` instructs, or null. */
export function requestedAddress(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const ton: unknown = Reflect.get(request, 'ton');
  if (typeof ton !== 'object' || ton === null) return null;
  const to: unknown = Reflect.get(ton, 'toAddress');
  return typeof to === 'string' ? to : null;
}
