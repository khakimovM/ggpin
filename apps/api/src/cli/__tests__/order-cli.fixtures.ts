import { randomBytes } from 'node:crypto';
import { transitionOrder, type AttemptStatus, type Prisma, type TonTransferStatus } from '@repo/db';
import { TON_NOT_SENT_MARGIN_MS, type OrderStatusReason } from '@repo/shared';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import {
  insertPaidOrder,
  insertQuote,
  type OrdersCatalog,
} from '../../modules/orders/__tests__/orders-e2e.fixtures';

// Orders for the owner CLI e2e files (phase 5 S10), built only along the legal paths the database
// allows (migration 10, D-60): the purchase writes Order(PAID) + PURCHASE together, the status
// follows the machine through `transitionOrder` (so every step has its OrderEvent and note), an
// attempt is born SENDING for a PROCESSING order and a transfer is born SIGNED for it, then moved
// with the chain data its state needs. Synthetic hashes and wallets; one wallet per transfer (the
// database allows one unresolved message per wallet).

type Db = PrismaService['client'];

const HOUR = 3_600_000;
/** Long past: an EXPIRED transfer is legal only after validUntil + margin by the DB clock. */
export const VALID_UNTIL = new Date(Date.now() - 6 * HOUR);

const hex64 = (): string => randomBytes(32).toString('hex');

export interface TransferRow {
  readonly id: string;
  readonly extMsgHash: string;
  readonly walletAddress: string;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
  readonly seqno: number;
  readonly validUntil: Date;
  readonly amountNanoTon: bigint;
}

async function step(
  db: Db,
  orderId: string,
  from: 'PAID' | 'QUEUED' | 'PROCESSING',
  to: 'QUEUED' | 'PROCESSING' | 'HELD' | 'NEEDS_REVIEW',
  reason?: OrderStatusReason,
  note?: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    if (to === 'HELD' || to === 'NEEDS_REVIEW') {
      await transitionOrder(tx, {
        orderId,
        from,
        to,
        actor: 'system',
        reason: reason ?? 'ADAPTER_ERROR',
        ...(note === undefined ? {} : { note }),
      });
      return;
    }
    await transitionOrder(tx, { orderId, from, to, actor: 'system' });
  });
}

/** A paid order of `userId` walked to PROCESSING (the purchase transaction, then the worker). */
export async function processingOrder(
  db: Db,
  catalog: OrdersCatalog,
  userId: string,
  priceTiyin?: bigint,
): Promise<string> {
  const quote = await insertQuote(db, catalog, userId, {
    ...(priceTiyin === undefined ? {} : { priceTiyin }),
  });
  const { orderId } = await insertPaidOrder(db, quote);
  await step(db, orderId, 'PAID', 'QUEUED');
  await step(db, orderId, 'QUEUED', 'PROCESSING');
  return orderId;
}

/** A HELD order (no payout yet) with the worker's hold note. */
export async function heldOrder(
  db: Db,
  catalog: OrdersCatalog,
  userId: string,
  note: string,
  reason: OrderStatusReason = 'LOW_BALANCE',
): Promise<string> {
  const orderId = await processingOrder(db, catalog, userId);
  await step(db, orderId, 'PROCESSING', 'HELD', reason, note);
  return orderId;
}

/**
 * A HELD order whose attempts were failed with these `error`s first (each born SENDING while the
 * order was PROCESSING, then FAILED, as the worker leaves them), held with the worker's note.
 * `firstAttemptNo`: the number of the first one (an order released before has older attempts).
 */
export async function heldAfterAttempts(
  db: Db,
  catalog: OrdersCatalog,
  userId: string,
  errors: readonly string[],
  note: string,
  reason: OrderStatusReason = 'ADAPTER_ERROR',
  firstAttemptNo = 1,
): Promise<string> {
  const orderId = await processingOrder(db, catalog, userId);
  for (const [index, error] of errors.entries()) {
    const attempt = await db.fulfillmentAttempt.create({
      data: {
        orderId,
        attemptNo: firstAttemptNo + index,
        adapter: 'FRAGMENT',
        status: 'SENDING',
        request: {},
        externalRef: `ref-${randomBytes(6).toString('hex')}`,
      },
    });
    await db.fulfillmentAttempt.update({
      where: { id: attempt.id },
      data: { status: 'FAILED', error },
    });
  }
  await step(db, orderId, 'PROCESSING', 'HELD', reason, note);
  return orderId;
}

function chainData(status: TonTransferStatus) {
  if (status === 'CONFIRMED' || status === 'ONCHAIN_FAILED' || status === 'BOUNCED') {
    return {
      txHash: hex64(),
      txLt: 48_123_456_000_000n + BigInt(randomBytes(2).readUInt16BE()),
      confirmedAt: new Date(),
    };
  }
  return {};
}

export interface ReviewOptions {
  readonly priceTiyin?: bigint;
  readonly attempt?: AttemptStatus;
  /** Stored on the attempt as the worker records it (e.g. `{ ton: { bounce } }`). */
  readonly response?:
    Prisma.InputJsonObject | ((transfer: TransferRow | null) => Prisma.InputJsonObject);
}

/**
 * A NEEDS_REVIEW order (CONFIRM_TIMEOUT) whose one attempt paid with one TON transfer in
 * `transfer`, as the worker and the reconciler leave it; `null`: an attempt with no transfer.
 */
export async function reviewOrder(
  db: Db,
  catalog: OrdersCatalog,
  userId: string,
  transfer: TonTransferStatus | null,
  options: ReviewOptions = {},
): Promise<{ readonly orderId: string; readonly transfer: TransferRow | null }> {
  const orderId = await processingOrder(db, catalog, userId, options.priceTiyin);
  const attempt = await db.fulfillmentAttempt.create({
    data: {
      orderId,
      attemptNo: 1,
      adapter: 'FRAGMENT',
      status: 'SENDING',
      request: {},
      externalRef: `ref-${randomBytes(6).toString('hex')}`,
    },
  });
  let row: TransferRow | null = null;
  if (transfer !== null) {
    const created = await db.tonTransfer.create({
      data: {
        purpose: 'ORDER',
        attemptId: attempt.id,
        network: 'mainnet',
        walletAddress: `0:${hex64()}`,
        seqno: 41,
        validUntil: VALID_UNTIL,
        toAddress: `0:${'c'.repeat(64)}`,
        amountNanoTon: 235_000_000n,
        payloadHash: 'd'.repeat(64),
        extMsgHash: hex64(),
        bocBase64: 'te6cc',
        status: 'SIGNED',
      },
    });
    if (transfer === 'BOUNCED') {
      await db.tonTransfer.update({ where: { id: created.id }, data: { status: 'BROADCAST' } });
    }
    row =
      transfer === 'SIGNED'
        ? created
        : await db.tonTransfer.update({
            where: { id: created.id },
            data: { status: transfer, ...chainData(transfer) },
          });
  }
  await db.fulfillmentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: options.attempt ?? 'UNKNOWN',
      ...(options.response === undefined
        ? {}
        : {
            response:
              typeof options.response === 'function' ? options.response(row) : options.response,
          }),
    },
  });
  await step(db, orderId, 'PROCESSING', 'NEEDS_REVIEW', 'CONFIRM_TIMEOUT');
  return { orderId, transfer: row };
}

export const tonTxProof = (t: TransferRow) => ({
  kind: 'TON_TX',
  extMsgHash: t.extMsgHash,
  walletAddress: t.walletAddress,
  txHash: t.txHash,
  lt: (t.txLt ?? 0n).toString(),
});

export const notSentProof = (t: TransferRow) => ({
  kind: 'TON_NOT_SENT',
  extMsgHash: t.extMsgHash,
  walletAddress: t.walletAddress,
  seqno: t.seqno,
  validUntil: t.validUntil.toISOString(),
  checkedSeqno: t.seqno,
  checkedAt: new Date(t.validUntil.getTime() + TON_NOT_SENT_MARGIN_MS).toISOString(),
});

export const MANUAL_PROOF = { kind: 'MANUAL', evidence: 'Fragment history checked by the owner' };

/** The rows a resolve leaves (or must not leave) behind. */
export async function moneyOf(db: Db, orderId: string) {
  const [order, refunds, audits] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    db.ledgerEntry.findMany({ where: { refType: 'ORDER', refId: orderId, kind: 'REFUND' } }),
    db.auditLog.findMany({
      where: { targetId: orderId, action: 'ORDER_REVIEW_RESOLVE' },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { status: order.status, refunds, audits };
}
