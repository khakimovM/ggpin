import type { OrderStatus } from '@repo/shared';
import type { AttemptStatus, TonTransferStatus, Tx } from '../src/index';
import { db } from './client';
import { createOrder, createUser } from './factories';

import { deliverLegally } from './order-delivery';

export * from './order-admins';
export { deliverLegally };
export * from './order-proofs';

// Shared by the order helper e2e files.
//
// The database lets rows come into being only along the legal paths (migration 10): an order is
// born PAID and follows the machine, an attempt is born SENDING for a PROCESSING order, a transfer
// is born SIGNED for a SENDING attempt, a REFUNDED order has its REFUND ledger entry, and a
// transfer is EXPIRED only after the margin. The builders below walk those paths. The `force*`
// builders and `bypassingGuards` build rows the database REFUSES (a corrupt or hand-edited
// database), to prove that the helpers of @repo/db refuse them as well.

export const PRICE = 5_000_000n; // the factory's priceTiyin

const PATH: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PAID: [],
  QUEUED: ['QUEUED'],
  PROCESSING: ['QUEUED', 'PROCESSING'],
  HELD: ['QUEUED', 'PROCESSING', 'HELD'],
  NEEDS_REVIEW: ['QUEUED', 'PROCESSING', 'NEEDS_REVIEW'],
  DELIVERED: ['QUEUED', 'PROCESSING', 'DELIVERED'],
  FAILED: ['QUEUED', 'PROCESSING', 'FAILED'],
  CANCELLED: ['CANCELLED'],
  REFUNDED: ['QUEUED', 'PROCESSING', 'FAILED', 'REFUNDED'],
};

/**
 * Runs `fn` with every trigger of the connection switched off (`session_replication_role =
 * replica`, local to the transaction; the test role is a superuser, audit L1). Only for building a
 * state the guards refuse.
 */
export function bypassingGuards<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    return fn(tx);
  });
}

export async function walkTo(orderId: string, status: OrderStatus): Promise<void> {
  for (const step of PATH[status]) {
    if (step === 'REFUNDED') {
      // The database wants the REFUND ledger entry in the same transaction as REFUNDED.
      await db.$transaction(async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        await tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
        await tx.ledgerEntry.create({
          data: {
            userId: order.userId,
            kind: 'REFUND',
            amountTiyin: order.priceTiyin - order.discountTiyin,
            refType: 'ORDER',
            refId: orderId,
          },
        });
      });
      continue;
    }
    if (step === 'DELIVERED') {
      await deliverLegally(orderId);
      continue;
    }
    await db.order.update({ where: { id: orderId }, data: { status: step } });
  }
}

/** An order of `user` in `status`, with its PURCHASE entry (createOrder writes both, D-60). */
export async function orderIn(
  user: Awaited<ReturnType<typeof createUser>>,
  status: OrderStatus,
  overrides: Parameters<typeof createOrder>[2] = {},
) {
  const order = await createOrder(user, undefined, overrides);
  await walkTo(order.id, status);
  return db.order.findUniqueOrThrow({ where: { id: order.id } });
}

/**
 * An order of `user` in `status` WITHOUT a PURCHASE entry: a state the database refuses
 * (Order_purchase_ledger_check), built with the triggers off, to prove the helpers refuse it too.
 * `forcePurchase` then adds a debit the database would also refuse (another amount, another user).
 */
export async function orderWithoutDebitIn(
  user: Awaited<ReturnType<typeof createUser>>,
  status: OrderStatus,
) {
  const order = await createOrder(user, undefined, {}, { unguarded: true });
  await walkTo(order.id, status);
  return db.order.findUniqueOrThrow({ where: { id: order.id } });
}

/** A PURCHASE entry written with the triggers off (the database refuses it at COMMIT). */
export function forcePurchase(userId: string, orderId: string, amountTiyin: bigint) {
  return bypassingGuards((tx) =>
    tx.ledgerEntry.create({
      data: { userId, kind: 'PURCHASE', amountTiyin, refType: 'ORDER', refId: orderId },
    }),
  );
}

/** A user with a wallet, an order in `status` and its PURCHASE entry, like the purchase leaves it. */
export async function paidOrder(status: OrderStatus, discountTiyin = 0n) {
  const user = await createUser();
  await db.wallet.create({ data: { userId: user.id } });
  const order = await orderIn(user, status, { discountTiyin });
  return { user, order };
}

export const events = (orderId: string) =>
  db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
export const refunds = (orderId: string) =>
  db.ledgerEntry.findMany({ where: { refType: 'ORDER', refId: orderId, kind: 'REFUND' } });
export const statusOf = async (orderId: string) =>
  (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;

export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

// ---- payouts: attempts and TON transfers of an order -----------------------------------------

let counter = 0;
const next = (): number => ++counter;

export const VALID_UNTIL = new Date('2026-11-11T10:01:00.000Z');
/** The clock the resolve tests pass to `resolveNeedsReviewAt`: after every proof time. */
export const NOW = new Date('2026-11-11T12:00:00.000Z');

interface AttemptOptions {
  attemptNo?: number;
  externalRef?: string | null;
}

/**
 * An attempt in `status`, built the legal way: born SENDING (so the order must be PROCESSING),
 * then moved by the single edge SENDING has to `status`.
 */
export async function addAttempt(
  orderId: string,
  status: AttemptStatus,
  options: AttemptOptions = {},
) {
  const row = await db.fulfillmentAttempt.create({
    data: {
      orderId,
      attemptNo: options.attemptNo ?? 1,
      adapter: 'FRAGMENT',
      status: 'SENDING',
      request: {},
      externalRef: options.externalRef === undefined ? `ref-${next()}` : options.externalRef,
    },
  });
  if (status === 'SENDING') return row;
  return db.fulfillmentAttempt.update({ where: { id: row.id }, data: { status } });
}

/** An attempt inserted directly in `status` on an order in ANY status (the database refuses it). */
export function forceAttempt(orderId: string, status: AttemptStatus, options: AttemptOptions = {}) {
  return bypassingGuards((tx) =>
    tx.fulfillmentAttempt.create({
      data: {
        orderId,
        attemptNo: options.attemptNo ?? 1,
        adapter: 'FRAGMENT',
        status,
        request: {},
        externalRef: options.externalRef === undefined ? `ref-${next()}` : options.externalRef,
      },
    }),
  );
}

const hex64 = (n: number): string => n.toString(16).padStart(64, '0');

interface TransferOptions {
  wallet?: string;
  seqno?: number;
  extMsgHash?: string;
}

function transferData(attemptId: string, options: TransferOptions) {
  const n = next();
  return {
    n,
    data: {
      purpose: 'ORDER',
      attemptId,
      network: 'mainnet',
      // A wallet of its own by default: the DB allows one unresolved message per wallet.
      walletAddress: options.wallet ?? `0:${hex64(n).replace(/^0/, 'a')}`,
      seqno: options.seqno ?? 41,
      validUntil: VALID_UNTIL,
      toAddress: '0:' + 'c'.repeat(64),
      amountNanoTon: 235_000_000n,
      payloadHash: 'd'.repeat(64),
      extMsgHash: options.extMsgHash ?? hex64(n),
      bocBase64: 'te6cc',
    },
  };
}

/** The chain data a transfer carries in `status` (the CHECKs want it exactly there). */
export function chainData(status: TonTransferStatus, n: number) {
  if (status === 'CONFIRMED') {
    return { txHash: hex64(n + 1_000_000), txLt: 48_123_456_000_001n, confirmedAt: new Date() };
  }
  if (status === 'ONCHAIN_FAILED') {
    return { txHash: hex64(n + 1_000_000), txLt: 48_123_456_000_002n, confirmedAt: new Date() };
  }
  if (status === 'BOUNCED') {
    return { txHash: hex64(n + 1_000_000), txLt: 48_123_456_000_003n, confirmedAt: new Date() };
  }
  return {};
}

/** Moves a transfer to `status` along its machine, with the chain data that status needs. */
export async function moveTransfer(id: string, status: TonTransferStatus) {
  // BOUNCED is reached from BROADCAST, never straight from SIGNED (owner decision A1).
  if (status === 'BOUNCED')
    await db.tonTransfer.update({ where: { id }, data: { status: 'BROADCAST' } });
  return db.tonTransfer.update({
    where: { id },
    data: { status, ...chainData(status, next()) },
  });
}

/**
 * A TON transfer in `status`, built the legal way: born SIGNED for an attempt that is still
 * SENDING (of a PROCESSING order), then moved with the chain data its target needs. EXPIRED works
 * because `VALID_UNTIL` is long past.
 */
export async function addTransfer(
  attemptId: string,
  status: TonTransferStatus,
  options: TransferOptions = {},
) {
  const { data } = transferData(attemptId, options);
  const created = await db.tonTransfer.create({ data: { ...data, status: 'SIGNED' } });
  return status === 'SIGNED' ? created : moveTransfer(created.id, status);
}

/** A transfer inserted directly in `status` for any attempt (the database refuses it). */
export function forceTransfer(
  attemptId: string,
  status: TonTransferStatus,
  options: TransferOptions = {},
) {
  const { n, data } = transferData(attemptId, options);
  return bypassingGuards((tx) =>
    tx.tonTransfer.create({ data: { ...data, status, ...chainData(status, n) } }),
  );
}

/**
 * A NEEDS_REVIEW order whose one attempt (UNKNOWN by default) paid with one TON transfer in
 * `transfer`: built along the legal path PROCESSING -> attempt SENDING -> transfer -> attempt moved
 * -> NEEDS_REVIEW, as the worker and the reconciler leave it.
 */
export async function reviewOrder(
  transfer: TonTransferStatus,
  attempt: AttemptStatus = 'UNKNOWN',
  discountTiyin = 0n,
) {
  const base = await paidOrder('PROCESSING', discountTiyin);
  const sending = await addAttempt(base.order.id, 'SENDING');
  const transferRow = await addTransfer(sending.id, transfer);
  const attemptRow =
    attempt === 'SENDING'
      ? sending
      : await db.fulfillmentAttempt.update({
          where: { id: sending.id },
          data: { status: attempt },
        });
  const order = await db.order.update({
    where: { id: base.order.id },
    data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
  });
  return { ...base, order, attempt: attemptRow, transfer: transferRow };
}

/** Moves an attempt to `status` along its machine (the transfer, if any, must allow it). */
export const moveAttempt = (id: string, status: AttemptStatus) =>
  db.fulfillmentAttempt.update({ where: { id }, data: { status } });
