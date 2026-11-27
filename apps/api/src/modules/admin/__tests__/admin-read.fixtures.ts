import { randomBytes } from 'node:crypto';
import { appendLedgerEntry, type PrismaClient } from '@repo/db';
import { fixtureCatalog } from './admin-fixture-orders';
import { freshFxSource } from './admin-fixture-purge';
import { EXTRA_ORDER_PRICE, worldOrders, type ExtraStatus } from './admin-read.orders';

export { PHONE } from './admin-read.orders';

export type { ExtraStatus } from './admin-read.orders';

// Rows for the admin read e2e on the shared *_test database, all SYNTHETIC: PAN prefix 9995 with
// this holder (payments 9999, worker 9998, notify 9996), bank sender ids 930…, and every card
// RETIRED from the start, so the payments suites never see a foreign live card. The orders sit on
// the persistent `ar-fixture` catalog (admin-fixture-orders.ts: an order is never deleted, so its
// product stays); the fresh FX rate and cost snapshot the price preview reads are unreferenced and
// purged before and after each suite (purgeFixtureCatalogAround, admin-fixture-purge.ts). The rest
// is append-only or harmless and is kept (like the other suites' bank rows).

export const READ_HOLDER = 'ADMIN READ E2E HOLDER';
/** A full 16-digit number in the raw bank text: it must never reach a non-OWNER, nor any card field. */
export const RAW_PAN = '9995123412341234';
/** A P2P amount: a whole base plus a unique tail (PaymentIntent_p2p_check). */
export const TOPUP_TIYIN = 2_012_300n;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const hex = (n: number): string => randomBytes(n).toString('hex');

const runSeed = BigInt(Date.now());
const SENDER_ID = 930_000_000_000n + (runSeed % 1_000_000n);
let messageSeq = runSeed * 1_000n;

export interface ReadWorld {
  readonly user: { id: string; telegramId: bigint; username: string };
  readonly cardId: string;
  readonly last4: string;
  readonly messageId: string;
  readonly paymentId: string;
  readonly intentId: string;
  readonly reviewId: string;
  readonly reviewMessageId: string;
  readonly orderId: string;
  /** The extra orders, created (and so listed) before the delivered one. */
  readonly extraOrderIds: readonly string[];
  readonly productId: string;
  readonly skuId: string;
  readonly categoryId: string;
  readonly fxRateId: string;
  /** SUM(ledger) of the user. */
  readonly balanceTiyin: bigint;
  /**
   * [the delivered order's createdAt, its deliveredAt + 1 ms), by the database clock: a window of
   * the PRESENT, so it holds exactly this world's dated rows (the user, the order, the confirmed
   * top-up) only because nothing else writes to this test database meanwhile. That holds on the p9
   * lane: its e2e runs only under the e2e-lane lock, and jest runs the suites in band (one at a
   * time, maxWorkers 1). Running another writer on the same database breaks the dashboard figures.
   */
  readonly window: { readonly from: Date; readonly to: Date };
  /** deliveredAt - createdAt of the delivered order in whole seconds (Math.round), >= 2. */
  readonly deliverySec: number;
}

async function retiredCard(db: PrismaClient) {
  const digits = randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000;
  const pan = `9995${String(digits).padStart(12, '0')}`;
  return db.topupCard.create({
    data: {
      bank: 'HUMO',
      pan,
      last4: pan.slice(-4),
      holderName: READ_HOLDER,
      status: 'RETIRED',
      retiredAt: new Date(),
      receiveLimitTiyin: 1_000_000_000n,
      verifyAmountTiyin: 112_300n,
      verifiedAt: new Date(Date.now() - 10 * DAY),
    },
  });
}

async function creditMessage(
  db: PrismaClient,
  card: { id: string; last4: string },
  amount: bigint,
) {
  messageSeq += 1n;
  const tgDate = new Date(Date.now() - MINUTE);
  return db.bankMessage.create({
    data: {
      source: 'HUMO_BOT',
      senderId: SENDER_ID,
      tgMessageId: messageSeq,
      tgDate,
      textSha256: hex(32),
      parserVersion: 1,
      parseStatus: 'PARSED',
      direction: 'CREDIT',
      amountTiyin: amount,
      balanceAfterTiyin: 777_000_000n,
      last4: card.last4,
      bankTxnAt: tgDate,
      cardId: card.id,
      channel: 'P2P',
      rawText: {
        create: {
          text: `Popolnenie ${RAW_PAN} summa ${String(amount / 100n)}`,
          purgeAfter: new Date(Date.now() + 30 * DAY),
        },
      },
    },
  });
}

/** The world's catalog: the persistent pack, its FRAGMENT route, and fresh pricing inputs. */
async function readCatalog(db: PrismaClient) {
  const catalog = await fixtureCatalog(db, 'ar-');
  const { productId, skuId } = catalog;
  await db.productRoute.upsert({
    where: { productId_adapter: { productId, adapter: 'FRAGMENT' } },
    create: { productId, adapter: 'FRAGMENT', priority: 1 },
    update: { priority: 1, isEnabled: true },
  });
  // The newest USDT_UZS rate and cost snapshot right now: what the price preview reads.
  const fxRate = await db.fxRate.create({
    data: { pair: 'USDT_UZS', rate: '12500', source: freshFxSource('ar-') },
  });
  await db.costSnapshot.create({
    data: {
      productId,
      skuId,
      adapter: 'FRAGMENT',
      currency: 'USDT',
      basisQuantity: 50,
      costMinor: 1_000_000n,
      source: 'simulator',
    },
  });
  return { catalog, fxRateId: fxRate.id };
}

/**
 * One user with a phone, the delivered order above (after the `extra` orders, each in its status
 * with its own PURCHASE), a confirmed top-up and an adjustment, and an OPEN NO_MATCH review on a
 * second credit message. The user's creation and the top-up's confirmation are stamped at the
 * delivered order's creation, so `window` holds exactly the world's dated rows.
 */
export async function buildReadWorld(
  db: PrismaClient,
  options: { readonly extra?: readonly ExtraStatus[] } = {},
): Promise<ReadWorld> {
  const card = await retiredCard(db);
  const { catalog, fxRateId } = await readCatalog(db);
  const { user, extraOrderIds, order } = await worldOrders(db, catalog, options.extra ?? []);
  const username = user.username ?? '';
  const at = order.createdAt;
  await db.user.update({ where: { id: user.id }, data: { createdAt: at } });

  const message = await creditMessage(db, card, TOPUP_TIYIN);
  const createdAt = new Date(message.tgDate.getTime() - 5 * MINUTE);
  const expiresAt = new Date(createdAt.getTime() + 30 * MINUTE);
  const { intent, payment } = await db.$transaction(async (tx) => {
    const intent = await tx.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'P2P_CARD',
        cardId: card.id,
        amountTiyin: TOPUP_TIYIN,
        baseAmountTiyin: 2_000_000n,
        status: 'PAID',
        purpose: 'TOPUP',
        idempotencyKey: `ar-${hex(8)}`,
        requestHash: 'h',
        createdAt,
        expiresAt,
        paidAt: message.tgDate,
        reservedUntil: new Date(expiresAt.getTime() + DAY),
      },
    });
    const payment = await tx.payment.create({
      data: {
        intentId: intent.id,
        userId: user.id,
        provider: 'P2P_CARD',
        providerTxnId: `${SENDER_ID.toString()}:${message.tgMessageId.toString()}`,
        amountTiyin: TOPUP_TIYIN,
        status: 'CONFIRMED',
        bankMessageId: message.id,
        confirmedAt: at,
        raw: { secretish: 'never shown' },
      },
    });
    await appendLedgerEntry(tx, {
      userId: user.id,
      kind: 'ADJUSTMENT',
      amountTiyin: 5_000_000n,
      refType: 'ADMIN_ACTION',
      refId: `ar-${hex(6)}`,
    });
    await appendLedgerEntry(tx, {
      userId: user.id,
      kind: 'TOPUP',
      amountTiyin: TOPUP_TIYIN,
      refType: 'PAYMENT',
      refId: payment.id,
    });
    return { intent, payment };
  });

  const reviewMessage = await creditMessage(db, card, 3_000_000n);
  const review = await db.paymentReview.create({
    data: { kind: 'NO_MATCH', bankMessageId: reviewMessage.id, cardId: card.id },
  });

  const extraDebits = EXTRA_ORDER_PRICE * BigInt(extraOrderIds.length);
  return {
    user: { id: user.id, telegramId: user.telegramId, username },
    cardId: card.id,
    last4: card.last4,
    messageId: message.id,
    paymentId: payment.id,
    intentId: intent.id,
    reviewId: review.id,
    reviewMessageId: reviewMessage.id,
    orderId: order.id,
    extraOrderIds,
    productId: catalog.productId,
    skuId: catalog.skuId,
    categoryId: catalog.categoryId,
    fxRateId,
    // ADJUSTMENT + TOPUP - the delivered order's PURCHASE (price - discount) - the extras'.
    balanceTiyin: 5_000_000n + TOPUP_TIYIN - 1_500_000n - extraDebits,
    window: { from: at, to: new Date(order.deliveredAt.getTime() + 1) },
    deliverySec: Math.round(order.gapMs / 1000),
  };
}
