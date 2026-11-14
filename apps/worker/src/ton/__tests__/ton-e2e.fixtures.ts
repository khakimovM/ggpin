import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { parseMajor } from '@repo/shared';
import { Address, beginCell } from '@ton/core';
import type { TonPayRequest } from '../ton-payout';

// Rows built along the legal paths of migrations 10 and 11 (like packages/db/test/factories.ts): an
// order is born PAID for its quote together with its PURCHASE debit in ONE transaction (migration
// 11 checks the pair at COMMIT, D-60) and walks QUEUED -> PROCESSING; its attempt is born SENDING
// with no reference yet (S5 writes the external message hash when it signs). Every name carries a
// per-run tag; rows stay in the scratch database (FulfillmentAttempt and TonTransfer refuse deletes).

let counter = 0;
const tag = (): string =>
  `${Date.now().toString(36)}${(++counter).toString(36)}${randomBytes(3).toString('hex')}`;

export interface PayoutFixture {
  readonly userId: string;
  readonly orderId: string;
  readonly attemptId: string;
}

export async function addAttempt(
  db: PrismaClient,
  orderId: string,
  attemptNo: number,
): Promise<string> {
  const attempt = await db.fulfillmentAttempt.create({
    data: { orderId, attemptNo, adapter: 'FRAGMENT', status: 'SENDING', request: {} },
    select: { id: true },
  });
  return attempt.id;
}

/** An order of a new user, PROCESSING, with attempt 1 SENDING (what S4 hands to the TON module). */
export async function processingOrder(db: PrismaClient): Promise<PayoutFixture> {
  const t = tag();
  const user = await db.user.create({
    data: {
      telegramId: BigInt(`7${String(Date.now()).slice(-9)}${String(counter)}`),
      referralCode: `ton${t}`,
    },
  });
  const category = await db.category.create({
    data: { slug: `ton-cat-${t}`, nameUz: 'Kategoriya', nameRu: 'Категория' },
  });
  const product = await db.product.create({
    data: {
      slug: `ton-prod-${t}`,
      categoryId: category.id,
      nameUz: 'Mahsulot',
      nameRu: 'Товар',
      imageUrl: 'https://example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [],
    },
  });
  const fxRate = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '30000.5', source: 'ton-e2e' },
  });
  const costSnapshot = await db.costSnapshot.create({
    data: {
      productId: product.id,
      adapter: 'FRAGMENT',
      currency: 'TON',
      basisQuantity: 50,
      costMinor: 1_000_000_000n,
      source: 'ton-e2e',
    },
  });
  const common = {
    userId: user.id,
    productId: product.id,
    quantity: 50,
    recipient: { username: 'someone' },
    costCurrency: 'TON',
    costMinor: 1_000_000_000n,
    fxRateId: fxRate.id,
    priceTiyin: 5_000_000n,
    maxCostMinor: 1_100_000_000n,
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
  await db.order.update({ where: { id: order.id }, data: { status: 'QUEUED' } });
  await db.order.update({ where: { id: order.id }, data: { status: 'PROCESSING' } });
  return { userId: user.id, orderId: order.id, attemptId: await addAttempt(db, order.id, 1) };
}

/** What an operator does to a stuck order: attempt FAILED, order FAILED, then REFUNDED + REFUND. */
export async function operatorFailsAndRefunds(db: PrismaClient, fixture: PayoutFixture) {
  await db.$transaction(async (tx) => {
    await tx.fulfillmentAttempt.update({
      where: { id: fixture.attemptId },
      data: { status: 'FAILED', error: 'operator' },
    });
    await tx.order.update({ where: { id: fixture.orderId }, data: { status: 'FAILED' } });
  });
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: fixture.orderId }, data: { status: 'REFUNDED' } });
    await tx.ledgerEntry.create({
      data: {
        userId: fixture.userId,
        kind: 'REFUND',
        amountTiyin: 5_000_000n,
        refType: 'ORDER',
        refId: fixture.orderId,
      },
    });
  });
}

/**
 * FRAGMENT_PAY_ADDRESSES of the e2e workers (the harness injects this very set as
 * TON_PAY_ADDRESSES): every payee() is on it, a stranger() is not.
 */
export const E2E_PAY_ADDRESSES = new Set<string>();

/** An address on no list (raw form). */
export function stranger(workchain: 0 | -1 = 0): string {
  return new Address(workchain, randomBytes(32)).toRawString();
}

/** A payee address of its own per test (raw form, as S8 will pass Fragment's), on the allowlist. */
export function payee(): string {
  const address = stranger();
  E2E_PAY_ADDRESSES.add(address);
  return address;
}

export function payRequest(
  fixture: PayoutFixture,
  overrides: Partial<TonPayRequest> = {},
): TonPayRequest {
  return {
    orderId: fixture.orderId,
    attemptId: fixture.attemptId,
    toAddress: payee(),
    amountNano: parseMajor('TON', '1'),
    payload: beginCell().storeUint(0, 32).storeStringTail('order payload').endCell(),
    ...overrides,
  };
}

/** The order, the attempt and its transfer as the database has them now. */
export async function rowsOf(db: PrismaClient, fixture: PayoutFixture) {
  const [order, attempt, transfer] = await Promise.all([
    db.order.findUniqueOrThrow({
      where: { id: fixture.orderId },
      select: { status: true, statusReason: true, deliveredAt: true },
    }),
    db.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: fixture.attemptId },
      select: { status: true, externalRef: true, error: true, response: true },
    }),
    db.tonTransfer.findUnique({ where: { attemptId: fixture.attemptId } }),
  ]);
  return { order, attempt, transfer };
}

/**
 * Every transfer of a wallet, in no particular order: `createdAt` is the database's clock, and the
 * Docker VM clock of a dev machine is stepped back by seconds now and then, so the tests find rows
 * by attempt, status or BOC instead of trusting the creation order.
 */
export function transfersOf(db: PrismaClient, walletAddress: string) {
  return db.tonTransfer.findMany({ where: { walletAddress } });
}

export function eventsTo(db: PrismaClient, orderId: string, to: 'DELIVERED' | 'NEEDS_REVIEW') {
  return db.orderEvent.count({ where: { orderId, to } });
}

/** The job's refId, and its leading row id for a composite `<id>_<attemptId>` one. */
export function refIdsOf(data: unknown): string[] {
  const refId =
    typeof data === 'object' && data !== null && 'refId' in data ? String(data.refId) : '';
  return [refId, refId.split('_')[0] ?? ''];
}

/** `response.ton[key]` of an attempt as stored (null when absent): no cast of the JSON column. */
export function tonFactOf(response: unknown, key: string): unknown {
  if (typeof response !== 'object' || response === null) return null;
  const ton: unknown = Reflect.get(response, 'ton');
  if (typeof ton !== 'object' || ton === null) return null;
  return Reflect.get(ton, key) ?? null;
}
