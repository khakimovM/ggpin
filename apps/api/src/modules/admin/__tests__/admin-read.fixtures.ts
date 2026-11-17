import { randomBytes } from 'node:crypto';
import { appendLedgerEntry, type PrismaClient } from '@repo/db';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';

// Rows for the admin read e2e on the shared *_test database, all SYNTHETIC: PAN prefix 9995 with
// this holder (payments 9999, worker 9998, notify 9996), bank sender ids 930…, and every card
// RETIRED from the start, so the payments suites never see a foreign live card. Everything is
// append-only or harmless; nothing here is cleaned (like the other suites' bank rows).

export const READ_HOLDER = 'ADMIN READ E2E HOLDER';
/** A full 16-digit number in the raw bank text: it must never reach a non-OWNER, nor any card field. */
export const RAW_PAN = '9995123412341234';
export const PHONE = '+998901234567';
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
  readonly productId: string;
  readonly skuId: string;
  readonly categoryId: string;
  readonly fxRateId: string;
  /** SUM(ledger) of the user. */
  readonly balanceTiyin: bigint;
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

async function catalog(db: PrismaClient) {
  const tag = hex(5);
  const category = await db.category.create({
    data: { slug: `ar-${tag}`, nameUz: `AR kat ${tag}`, nameRu: `AR кат ${tag}` },
  });
  const product = await db.product.create({
    data: {
      slug: `ar-${tag}`,
      categoryId: category.id,
      nameUz: `AR mahsulot ${tag}`,
      nameRu: `AR товар ${tag}`,
      imageUrl: 'https://cdn.example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'username' }],
    },
  });
  const sku = await db.sku.create({
    data: { productId: product.id, labelUz: '50', labelRu: '50', quantity: 50, markupBps: 1500 },
  });
  await db.productRoute.create({
    data: { productId: product.id, adapter: 'FRAGMENT', priority: 1 },
  });
  return { category, product, sku };
}

/**
 * One user with a phone, three ledger entries (an adjustment, a credited top-up and a purchase),
 * a DELIVERED order delivered at `deliveredAt` (price 16 000, discount 1 000, cost 1 USDT at
 * 12 500 so'm: profit 2 500 so'm), and an OPEN NO_MATCH review on a second credit message.
 */
export async function buildReadWorld(db: PrismaClient, deliveredAt: Date): Promise<ReadWorld> {
  const username = `ar_${hex(5)}`;
  const user = await db.user.create({
    data: {
      telegramId: BigInt(nextTestTelegramId()),
      username,
      firstName: 'Read',
      phone: PHONE,
      referralCode: `ar${hex(6)}`,
      createdAt: deliveredAt,
      wallet: { create: {} },
    },
  });
  const card = await retiredCard(db);
  const { category, product, sku } = await catalog(db);
  const fxRate = await db.fxRate.create({
    data: { pair: 'USDT_UZS', rate: '12500', source: 'e2e' },
  });
  const snapshot = await db.costSnapshot.create({
    data: {
      productId: product.id,
      skuId: sku.id,
      adapter: 'FRAGMENT',
      currency: 'USDT',
      basisQuantity: 50,
      costMinor: 1_000_000n,
      source: 'simulator',
    },
  });
  const recipient = { username: 'someone', displayName: 'Some One', photoUrl: 'https://x.test/p' };
  const quote = await db.quote.create({
    data: {
      userId: user.id,
      skuId: sku.id,
      productId: product.id,
      quantity: 50,
      recipient,
      costCurrency: 'USDT',
      costMinor: 1_000_000n,
      fxRateId: fxRate.id,
      costSnapshotId: snapshot.id,
      priceTiyin: 1_600_000n,
      maxCostMinor: 1_100_000n,
      expiresAt: new Date(deliveredAt.getTime() + 5 * MINUTE),
      usedAt: deliveredAt,
    },
  });
  const order = await db.order.create({
    data: {
      userId: user.id,
      quoteId: quote.id,
      productId: product.id,
      skuId: sku.id,
      quantity: 50,
      recipient,
      priceTiyin: 1_600_000n,
      discountTiyin: 100_000n,
      costCurrency: 'USDT',
      costMinor: 1_000_000n,
      maxCostMinor: 1_100_000n,
      fxRateId: fxRate.id,
      status: 'DELIVERED',
      idempotencyKey: `ar-${hex(8)}`,
      requestHash: 'h',
      createdAt: new Date(deliveredAt.getTime() - 90_000),
      deliveredAt,
    },
  });

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
        confirmedAt: deliveredAt,
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
    await appendLedgerEntry(tx, {
      userId: user.id,
      kind: 'PURCHASE',
      amountTiyin: -1_500_000n,
      refType: 'ORDER',
      refId: order.id,
    });
    return { intent, payment };
  });

  const reviewMessage = await creditMessage(db, card, 3_000_000n);
  const review = await db.paymentReview.create({
    data: { kind: 'NO_MATCH', bankMessageId: reviewMessage.id, cardId: card.id },
  });

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
    productId: product.id,
    skuId: sku.id,
    categoryId: category.id,
    fxRateId: fxRate.id,
    balanceTiyin: 5_000_000n + TOPUP_TIYIN - 1_500_000n,
  };
}

/** A unique past instant for one suite's dashboard window (no other suite writes there). */
export function isolatedInstant(): Date {
  const base = Date.UTC(2003, 0, 1);
  const slot = Number(runSeed % 1_000n) * DAY * 7 + Number(randomBytes(2).readUInt16BE(0)) * 1000;
  return new Date(base + slot + 12 * 3_600_000);
}
