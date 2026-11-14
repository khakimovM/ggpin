import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { simulatedFragmentCost } from '../../adapters/simulator/simulated-fragment.adapter';
import {
  RESELLER_STARS_ADAPTER,
  SIMULATED_STAR_MICRO_USDT,
} from '../../adapters/simulator/simulated-reseller.adapter';
import { simulatedProviderRef } from '../../adapters/simulator/simulator-script';

// Orders as POST /orders creates them (S2): born PAID for their quote together with the PURCHASE
// debit in ONE transaction (migration 11 checks the pair at COMMIT, D-60), the quote's fixed
// fields copied (the INSERT guard demands equality, providerRef included). Every name carries a
// per-run tag; rows stay in the scratch `_test` database (attempts and transfers refuse deletes).

let counter = 0;
const tag = (): string =>
  `${Date.now().toString(36)}${(++counter).toString(36)}${randomBytes(3).toString('hex')}`;

export const STARS = 50;
export const PRICE_TIYIN = 5_000_000n;

export interface OrderFixture {
  readonly userId: string;
  readonly orderId: string;
  readonly productId: string;
}

export interface OrderOptions {
  /** The route (and the cost currency): FRAGMENT (TON) by default, RESELLER_STARS (USDT). */
  readonly adapter?: 'FRAGMENT' | typeof RESELLER_STARS_ADAPTER;
  /** The stored providerRef; default: the simulator's handle of the username. */
  readonly providerRef?: string | null;
  /** Leaves the product without any route. */
  readonly noRoute?: boolean;
  /** The route's adapter when it differs from the one the quote was priced with. */
  readonly routeAdapter?: string;
}

function costOf(adapter: string) {
  if (adapter === 'FRAGMENT') {
    const cost = simulatedFragmentCost({ id: null, quantity: STARS });
    return { currency: 'TON', cost, max: (cost * 110n) / 100n } as const;
  }
  const cost = SIMULATED_STAR_MICRO_USDT * BigInt(STARS);
  return { currency: 'USDT', cost, max: (cost * 110n) / 100n } as const;
}

export async function paidOrder(
  db: PrismaClient,
  options: OrderOptions = {},
): Promise<OrderFixture> {
  const t = tag();
  const adapter = options.adapter ?? 'FRAGMENT';
  const username = `user${t}`.slice(0, 32);
  const providerRef =
    options.providerRef === undefined ? simulatedProviderRef(username) : options.providerRef;
  const { currency, cost, max } = costOf(adapter);
  const user = await db.user.create({
    data: {
      telegramId: BigInt(`8${String(Date.now()).slice(-9)}${String(counter)}`),
      referralCode: `ful${t}`,
    },
  });
  // The wallet row every user gets at sign-up: the refund path locks it (rules/20).
  await db.wallet.create({ data: { userId: user.id } });
  const category = await db.category.create({
    data: { slug: `ful-cat-${t}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
  });
  const product = await db.product.create({
    data: {
      slug: `ful-prod-${t}`,
      categoryId: category.id,
      nameUz: 'Mahsulot',
      nameRu: 'Товар',
      imageUrl: 'https://example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [],
    },
  });
  if (options.noRoute !== true) {
    await db.productRoute.create({
      data: { productId: product.id, adapter: options.routeAdapter ?? adapter, priority: 1 },
    });
  }
  const fxRate = await db.fxRate.create({
    data: { pair: `${currency}_UZS`, rate: '30000.5', source: 'fulfill-e2e' },
  });
  const costSnapshot = await db.costSnapshot.create({
    data: {
      productId: product.id,
      adapter,
      currency,
      basisQuantity: STARS,
      costMinor: cost,
      source: 'fulfill-e2e',
    },
  });
  const common = {
    userId: user.id,
    productId: product.id,
    quantity: STARS,
    recipient: { username, displayName: username },
    providerRef,
    costCurrency: currency,
    costMinor: cost,
    fxRateId: fxRate.id,
    priceTiyin: PRICE_TIYIN,
    maxCostMinor: max,
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
  return { userId: user.id, orderId: order.id, productId: product.id };
}

export function orderRow(db: PrismaClient, orderId: string) {
  return db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, statusReason: true, deliveredAt: true },
  });
}

export function attemptsOf(db: PrismaClient, orderId: string) {
  return db.fulfillmentAttempt.findMany({ where: { orderId }, orderBy: { attemptNo: 'asc' } });
}

export async function transfersOf(db: PrismaClient, orderId: string) {
  const attempts = await attemptsOf(db, orderId);
  return db.tonTransfer.findMany({ where: { attemptId: { in: attempts.map((a) => a.id) } } });
}

/** The order's status timeline, oldest first (createdAt can step back on a dev VM: by id too). */
export async function timelineOf(db: PrismaClient, orderId: string): Promise<string[]> {
  const events = await db.orderEvent.findMany({
    where: { orderId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { to: true },
  });
  return events.map((e) => e.to);
}

export function ledgerOf(db: PrismaClient, orderId: string) {
  return db.ledgerEntry.findMany({
    where: { refType: 'ORDER', refId: orderId },
    select: { kind: true, amountTiyin: true },
  });
}
