import { randomBytes } from 'node:crypto';
import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db';
import { FRAGMENT_PRODUCT_SLUGS, PREMIUM_MONTHS, walletCacheKey } from '@repo/shared';

// Phase 6 S6: the `telegram-premium` product as the full flow needs it. The simulator decides the
// product kind by the EXACT slug (owner Q4) and the slug is unique, so the one row of the test
// database is used:
// - Lock: for the WHOLE suite this run holds a session-level advisory lock on the key P6-S2's
//   fixture takes per transaction (`pg_advisory_xact_lock`), on one connection of its own client
//   pinned by an open transaction (holdLock). An S2 setup meanwhile waits for it; a second S6 run
//   stops at once with a clear error (try-lock). A crash ends the connection, which unlocks.
// - A TEST-made product (its category slug starts `ful-prem-cat-` from S2 or `flow-prem-cat-`
//   from here) is set to what the flow needs (active, the seed's Telegram form, the seed labels
//   "3 oylik" / "3 месяца" on the 3-month SKU, which the bot text quotes) and afterwards ALWAYS
//   back to S2's resting shape (inactive, no form, S2's labels "3 oylik" / "3 мес."), never to
//   "what it found": a run killed before its afterAll therefore cannot make a drift permanent.
// - A seeded product is never changed: it must already be in the flow's shape, else the suite
//   stops with a clear error.
// - Routes as in S2: an enabled FRAGMENT route (created when missing), no other enabled route.
// Price inputs: a fresh FRAGMENT cost row for the 3-month SKU (the simulator's 3.75 TON, so the
// worker's re-quote equals the quote's cost) and a TON_UZS rate. Both stay: FxRate is an immutable
// snapshot that this suite's quotes and orders reference (Restrict), and cost rows are history.

const LOCK_KEY = 'ggpin:e2e:telegram-premium-fixture';
const TEST_CATEGORY_PREFIXES = ['ful-prem-cat-', 'flow-prem-cat-'] as const;
const TG_FORM = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];
/** The seed labels of the 3-month SKU (packages/db/prisma/seed/catalog-data.ts PREMIUM_MONTHS). */
const SEED_3M = { labelUz: '3 oylik', labelRu: '3 месяца' } as const;
/** P6-S2's labels (premium-e2e.fixtures.ts): the resting shape of a test-made product. */
const restLabels = (months: number) =>
  ({ labelUz: `${String(months)} oylik`, labelRu: `${String(months)} мес.` }) as const;
/** The simulated Fragment price of 3 months (simulated-fragment-prices.ts), written out here. */
export const PREMIUM_3M_NANO = 3_750_000_000n;

export interface PremiumFlowCatalog {
  readonly productId: string;
  readonly sku3: string;
  /** Test-made product: back to S2's resting shape. Then the lock is released. */
  readonly restore: () => Promise<void>;
}

const tag = (): string => randomBytes(4).toString('hex');

async function findOrCreate(db: PrismaClient) {
  const slug = FRAGMENT_PRODUCT_SLUGS.PREMIUM;
  const select = {
    id: true,
    isActive: true,
    inputSchema: true,
    category: { select: { slug: true } },
  } as const;
  const product =
    (await db.product.findUnique({ where: { slug }, select })) ??
    (await db.product.create({
      // S2's resting shape: inactive, no form.
      data: {
        slug,
        category: {
          create: { slug: `flow-prem-cat-${tag()}`, nameUz: 'Telegram', nameRu: 'Telegram' },
        },
        nameUz: 'Telegram Premium',
        nameRu: 'Telegram Premium',
        imageUrl: 'https://example.test/premium.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: [],
        isActive: false,
        allowCustomQty: false,
      },
      select,
    }));
  const productId = product.id;
  const route = await db.productRoute.findUnique({
    where: { productId_adapter: { productId, adapter: 'FRAGMENT' } },
  });
  if (route === null) {
    await db.productRoute.create({ data: { productId, adapter: 'FRAGMENT', priority: 1 } });
  } else if (!route.isEnabled) {
    throw new Error('telegram-premium has a disabled FRAGMENT route: not changed by a test');
  }
  const others = await db.productRoute.findMany({
    where: { productId, isEnabled: true, adapter: { not: 'FRAGMENT' } },
    select: { adapter: true },
  });
  if (others.length > 0) {
    const names = others.map((r) => r.adapter).join(', ');
    throw new Error(`telegram-premium has other enabled routes (${names}): not changed by a test`);
  }
  let sku3: { id: string; labelUz: string; labelRu: string } | null = null;
  for (const months of PREMIUM_MONTHS) {
    // The same pick as P6-S2: the oldest active SKU of that term; a missing one as S2 makes it.
    const sku =
      (await db.sku.findFirst({
        where: { productId, quantity: months, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, labelUz: true, labelRu: true },
      })) ??
      (await db.sku.create({
        data: { productId, quantity: months, ...restLabels(months), markupBps: 1000 },
        select: { id: true, labelUz: true, labelRu: true },
      }));
    if (months === 3) sku3 = sku;
  }
  if (sku3 === null) throw new Error('no 3-month SKU');
  const testMade = TEST_CATEGORY_PREFIXES.some((p) => product.category.slug.startsWith(p));
  return { product, sku3, testMade };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The suite-long lock: a session-level advisory lock taken inside a transaction that stays open
 * until `release`, so the pool can never close (and silently unlock) that connection while the
 * suite runs. A crash ends the connection, which releases the lock.
 */
async function holdLock(db: PrismaClient): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: (ok: boolean) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve) => {
    held = resolve;
  });
  const tx = db.$transaction(
    async (t) => {
      const [row] = await t.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS ok`;
      held(row?.ok === true);
      if (row?.ok !== true) return;
      await gate;
      await t.$queryRaw`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
    },
    { maxWait: 10_000, timeout: 60 * 60_000 },
  );
  // A transaction that fails before it answers ends the race; a later failure surfaces in release.
  const failed = tx.then(() => false);
  failed.catch(() => undefined);
  if (!(await Promise.race([acquired, failed]))) {
    await tx;
    throw new Error('telegram-premium fixture lock is held by another run: not started');
  }
  return async () => {
    release();
    await tx;
  };
}

/** Makes `telegram-premium` sellable for this suite under a suite-long lock; see above. */
export async function premiumFlowCatalog(databaseUrl: string): Promise<PremiumFlowCatalog> {
  const db = createPrismaClient(databaseUrl);
  let unlock: () => Promise<void>;
  try {
    unlock = await holdLock(db);
  } catch (error) {
    await db.$disconnect();
    throw error;
  }
  try {
    const { product, sku3, testMade } = await findOrCreate(db);
    if (testMade) {
      await db.product.update({
        where: { id: product.id },
        data: { isActive: true, inputSchema: TG_FORM },
      });
      await db.sku.update({ where: { id: sku3.id }, data: SEED_3M });
    } else if (
      !product.isActive ||
      !sameJson(product.inputSchema, TG_FORM) ||
      sku3.labelUz !== SEED_3M.labelUz ||
      sku3.labelRu !== SEED_3M.labelRu
    ) {
      throw new Error(
        'a seeded telegram-premium is not in the shape this suite needs (active, Telegram form, ' +
          'seed labels): not changed by a test',
      );
    }
    await db.costSnapshot.create({
      data: {
        productId: product.id,
        skuId: sku3.id,
        adapter: 'FRAGMENT',
        currency: 'TON',
        basisQuantity: 3,
        costMinor: PREMIUM_3M_NANO,
        source: 'premium-flow-e2e',
      },
    });
    await db.fxRate.create({
      data: { pair: 'TON_UZS', rate: '40000', source: 'premium-flow-e2e' },
    });
    return {
      productId: product.id,
      sku3: sku3.id,
      restore: async () => {
        try {
          if (testMade) {
            const rest: Prisma.ProductUpdateInput = { isActive: false, inputSchema: [] };
            await db.product.update({ where: { id: product.id }, data: rest });
            await db.sku.update({ where: { id: sku3.id }, data: restLabels(3) });
          }
        } finally {
          await unlock().finally(() => db.$disconnect());
        }
      },
    };
  } catch (error) {
    await unlock().finally(() => db.$disconnect());
    throw error;
  }
}

/** A TOPUP entry standing for a confirmed top-up (the top-up flow is its own suite). */
export async function fund(
  db: PrismaClient,
  dropCache: (key: string) => Promise<unknown>,
  userId: string,
  amountTiyin: bigint,
): Promise<void> {
  await db.ledgerEntry.create({
    data: {
      userId,
      kind: 'TOPUP',
      amountTiyin,
      refType: 'PAYMENT',
      refId: `e2e_premium_flow_${randomBytes(8).toString('hex')}`,
    },
  });
  await dropCache(walletCacheKey(userId));
}
