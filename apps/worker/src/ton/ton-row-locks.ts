import {
  orderStatusReasonSchema,
  orderStatusSchema,
  type OrderStatus,
  type OrderStatusReason,
} from '@repo/shared';
import type { AttemptStatus, Prisma, TonTransferStatus, Tx } from '@repo/db';

// Row locks of the payout tables, always taken in the order of docs/06 "Qulf tartibi" (R8):
// (wallet ->) order -> attempt -> transfer. The worker never needs the user's Wallet row here: no
// money moves in a TON payout transaction (the refund is a separate, later transaction). Every
// lock is `FOR UPDATE`, like `lockOrderRow` of @repo/db: the guards of migration 10 read the same
// rows `FOR SHARE`, which waits for us, so a concurrent writer sees our committed state.

export interface LockedOrder {
  readonly status: OrderStatus;
  readonly reason: OrderStatusReason | null;
}

export interface LockedAttempt {
  readonly orderId: string;
  readonly status: AttemptStatus;
  readonly externalRef: string | null;
  readonly response: Prisma.JsonValue | null;
}

const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'SENDING',
  'SENT',
  'CONFIRMED',
  'FAILED',
  'UNKNOWN',
];
const TRANSFER_STATUSES: readonly TonTransferStatus[] = [
  'SIGNED',
  'BROADCAST',
  'CONFIRMED',
  'ONCHAIN_FAILED',
  'EXPIRED',
  'CONSUMED_UNMATCHED',
  'BOUNCED',
];

function attemptStatus(text: string): AttemptStatus {
  const status = ATTEMPT_STATUSES.find((s) => s === text);
  if (status === undefined) throw new Error('unknown FulfillmentAttempt status in the database');
  return status;
}

export function transferStatus(text: string): TonTransferStatus {
  const status = TRANSFER_STATUSES.find((s) => s === text);
  if (status === undefined) throw new Error('unknown TonTransfer status in the database');
  return status;
}

export async function lockOrder(tx: Tx, orderId: string): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<{ status: string; statusReason: string | null }[]>`
    SELECT "status"::text AS "status", "statusReason" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    status: orderStatusSchema.parse(row.status),
    reason: row.statusReason === null ? null : orderStatusReasonSchema.parse(row.statusReason),
  };
}

export async function lockAttempt(tx: Tx, attemptId: string): Promise<LockedAttempt | null> {
  const rows = await tx.$queryRaw<
    {
      orderId: string;
      status: string;
      externalRef: string | null;
      response: Prisma.JsonValue | null;
    }[]
  >`
    SELECT "orderId", "status"::text AS "status", "externalRef", "response"
    FROM "FulfillmentAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;
  return { ...row, status: attemptStatus(row.status) };
}

export async function lockTransfer(tx: Tx, transferId: string): Promise<TonTransferStatus | null> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "TonTransfer" WHERE "id" = ${transferId} FOR UPDATE`;
  const row = rows[0];
  return row === undefined ? null : transferStatus(row.status);
}

function asObject(value: Prisma.JsonValue | undefined | null): Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * An expiry witness contradicted "not sent" for the attempt's transfer (review m3): the fact kept
 * as `ton.witnessConflict` bars EXPIRED for good and calls for the owner's alert (review RR2-4).
 */
export function hasWitnessConflict(response: Prisma.JsonValue | null): boolean {
  const fact = asObject(asObject(response)['ton'])['witnessConflict'];
  return fact !== undefined && fact !== null;
}

/**
 * The attempt's response with the TON facts merged under `ton`: whatever else S4/S8 stored is
 * kept, and so are earlier TON facts (a later timeout does not erase a recorded bounce).
 */
export function withTonFacts(
  response: Prisma.JsonValue | null,
  facts: Prisma.InputJsonObject,
): Prisma.InputJsonObject {
  const base = asObject(response);
  return { ...base, ton: { ...asObject(base['ton']), ...facts } };
}
