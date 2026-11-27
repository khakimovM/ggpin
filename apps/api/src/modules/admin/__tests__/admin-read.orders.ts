import { randomBytes } from 'node:crypto';
import type { OrderStatus, PrismaClient } from '@repo/db';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import {
  fixtureDiscountCode,
  fixtureQuote,
  moveOrder,
  paidOrder,
  type FixtureCatalog,
} from './admin-fixture-orders';

// The read world's orders (admin-read.fixtures.ts): its user, the extra orders and the delivered
// one, with the database-clock checks the read suites rely on.

export const PHONE = '+998901234567';
const hex = (n: number): string => randomBytes(n).toString('hex');

/** The price of an extra (not delivered) order: no discount, its PURCHASE debits all of it. */
export const EXTRA_ORDER_PRICE = 1_600_000n;
/** The real time between the delivered order's creation and its delivery (database clock). */
const DELIVERY_WAIT_MS = 2_000;
/** The least gap a try keeps: it rounds to >= 2 s, the floor the dashboard suite asserts. */
const MIN_GAP_MS = 1_500;
/** An extra order's status: one that neither delivers nor refunds (its debit stays). */
export type ExtraStatus = Exclude<OrderStatus, 'DELIVERED' | 'REFUNDED'>;

const RECIPIENT = { username: 'someone', displayName: 'Some One', photoUrl: 'https://x.test/p' };

/** A world's user (its createdAt is re-stamped to the delivered order's once that order is good). */
function worldUser(db: PrismaClient) {
  return db.user.create({
    data: {
      telegramId: BigInt(nextTestTelegramId()),
      username: `ar_${hex(5)}`,
      firstName: 'Read',
      phone: PHONE,
      referralCode: `ar${hex(6)}`,
      wallet: { create: {} },
    },
  });
}

/**
 * One try at the world's orders: a fresh user, the `extra` orders, then the delivered order (price
 * 16 000, discount 1 000 with its code, cost 1 USDT at 12 500 so'm: profit 2 500 so'm), held
 * PROCESSING for DELIVERY_WAIT_MS of real time. `ok: false` when the database clock did not
 * give the times the suites rely on: the delivery gap under MIN_GAP_MS, an extra order not older
 * than the delivered one, or a time not after the previous try's rows (`notAfter`).
 */
async function tryOrders(
  db: PrismaClient,
  catalog: FixtureCatalog,
  extra: readonly ExtraStatus[],
  notAfter: Date,
) {
  const user = await worldUser(db);
  const extraOrderIds: string[] = [];
  for (const status of extra) {
    const quote = await fixtureQuote(db, catalog, user.id, {
      priceTiyin: EXTRA_ORDER_PRICE,
      recipient: RECIPIENT,
    });
    const order = await paidOrder(db, quote, 'ar-');
    await moveOrder(db, order.id, status);
    extraOrderIds.push(order.id);
  }
  const discountCodeId = await fixtureDiscountCode(db, user.id);
  const quote = await fixtureQuote(db, catalog, user.id, {
    priceTiyin: 1_600_000n,
    recipient: RECIPIENT,
    discountCodeId,
  });
  const order = await paidOrder(db, quote, 'ar-', 100_000n);
  await moveOrder(db, order.id, 'PROCESSING');
  await new Promise((resolve) => setTimeout(resolve, DELIVERY_WAIT_MS));
  await moveOrder(db, order.id, 'DELIVERED');
  const rows = await db.order.findMany({
    where: { userId: user.id },
    select: { id: true, createdAt: true, deliveredAt: true },
  });
  const row = rows.find((r) => r.id === order.id);
  const createdAt = row?.createdAt ?? notAfter;
  const deliveredAt = row?.deliveredAt ?? createdAt;
  const gapMs = deliveredAt.getTime() - createdAt.getTime();
  const extrasOlder = rows.every((r) => r.id === order.id || r.createdAt < createdAt);
  // Every dated row of this try (its user too): a later try must begin after all of them.
  const stamps = rows.flatMap((r) => [r.createdAt.getTime(), r.deliveredAt?.getTime() ?? 0]);
  const latest = new Date(Math.max(user.createdAt.getTime(), ...stamps));
  const ok =
    gapMs >= MIN_GAP_MS && extrasOlder && user.createdAt > notAfter && createdAt > notAfter;
  return {
    ok,
    user,
    extraOrderIds,
    order: { id: order.id, createdAt, deliveredAt, gapMs },
    latest,
  };
}

/**
 * The world's orders, tried up to three times. Not a loosened check: the times are what the
 * suites assert on (the dashboard window, avgDeliverySec, newest-first order lists), and they come
 * from the database clock, which the Docker/WSL VM steps back by ~3.2 s every ~27 s (memory note
 * "wsl-clock-jumps"). A try that such a step spoiled is left behind (another user; its rows end
 * before the next try begins) and a new one is made; three spoiled tries are an error.
 */
export async function worldOrders(
  db: PrismaClient,
  catalog: FixtureCatalog,
  extra: readonly ExtraStatus[],
) {
  let notAfter = new Date(0);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const done = await tryOrders(db, catalog, extra, notAfter);
    if (done.ok) return done;
    notAfter = done.latest;
  }
  throw new Error('fixture: the database clock spoiled three tries at the read world orders');
}
