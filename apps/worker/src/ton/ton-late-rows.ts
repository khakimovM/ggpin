import { isDeepStrictEqual } from 'node:util';
import type { Prisma, TonTransferStatus, Tx } from '@repo/db';
import {
  transferStatus,
  withTonFacts,
  type LockedAttempt,
  type LockedOrder,
} from './ton-row-locks';
import type { OurTxFacts } from './ton-tx-facts';

// The locked rows of one late write (phase 5 S9f) and the small helpers every write uses: the
// attempt's `response.ton` facts (written by value, a fact already there is never written twice),
// the chain fields of a transfer and the database clock. TonLateRepository locks the rows (order ->
// attempt -> transfer) before any of these run.

export interface LockedTransfer {
  readonly status: TonTransferStatus;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
}

export interface LateRows {
  readonly transferId: string;
  readonly transfer: LockedTransfer;
  readonly orderId: string | null;
  readonly order: LockedOrder | null;
  readonly attemptId: string | null;
  readonly attempt: LockedAttempt | null;
}

export interface LateWrite {
  readonly written: boolean;
  /** The order went PROCESSING -> NEEDS_REVIEW in this write (a late bounce). */
  readonly reviewed: boolean;
}

export const NOTHING: LateWrite = { written: false, reviewed: false };
export const WRITTEN: LateWrite = { written: true, reviewed: false };

export function chainFields(tx: OurTxFacts, confirmedAt: Date) {
  return { txHash: tx.hash, txLt: tx.lt, feeNanoTon: tx.feeNano, confirmedAt };
}

export function txFacts(tx: OurTxFacts): Prisma.InputJsonObject {
  return { txHash: tx.hash, txLt: tx.lt.toString(), feeNanoTon: tx.feeNano.toString() };
}

export function tonOf(response: Prisma.JsonValue | null): Prisma.JsonObject {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return {};
  const ton = response['ton'];
  return typeof ton === 'object' && ton !== null && !Array.isArray(ton) ? ton : {};
}

/** The attempt holds exactly these facts already (compared by value, not by text). */
function hasFacts(attempt: LockedAttempt, facts: Prisma.InputJsonObject): boolean {
  const ton = tonOf(attempt.response);
  return Object.entries(facts).every(([key, value]) => isDeepStrictEqual(ton[key], value));
}

export async function addFacts(
  tx: Tx,
  rows: LateRows,
  facts: Prisma.InputJsonObject,
): Promise<boolean> {
  const attempt = rows.attempt;
  if (attempt === null || rows.attemptId === null || hasFacts(attempt, facts)) return false;
  await tx.fulfillmentAttempt.update({
    where: { id: rows.attemptId },
    data: { response: withTonFacts(attempt.response, facts) },
  });
  return true;
}

/** `ton.<key>` is written once: a fact already there (whatever its values) is kept as it is. */
export async function addFactOnce(
  tx: Tx,
  rows: LateRows,
  key: string,
  value: Prisma.InputJsonObject,
): Promise<LateWrite> {
  if (rows.attempt === null || (tonOf(rows.attempt.response)[key] ?? null) !== null) return NOTHING;
  return (await addFacts(tx, rows, { [key]: value })) ? WRITTEN : NOTHING;
}

/** Locks one transfer row (the last lock of order -> attempt -> transfer); null when it is gone. */
export async function lockTransferRow(tx: Tx, transferId: string): Promise<LockedTransfer | null> {
  const rows = await tx.$queryRaw<{ status: string; txHash: string | null; txLt: bigint | null }[]>`
    SELECT "status"::text AS "status", "txHash", "txLt"
    FROM "TonTransfer" WHERE "id" = ${transferId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;
  return { status: transferStatus(row.status), txHash: row.txHash, txLt: row.txLt };
}

/** The database clock (epoch, never a timestamptz: docs/06 L1), read inside the transaction. */
export async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ ms: string }[]>`
    SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
  const ms = Number(rows[0]?.ms);
  if (!Number.isSafeInteger(ms)) throw new Error('the database clock could not be read');
  return new Date(ms);
}
