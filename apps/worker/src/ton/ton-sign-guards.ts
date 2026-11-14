import { transitionOrder, type Tx } from '@repo/db';
import type { TonHoldReason, TonStopReason } from './ton-payout';
import { lockAttempt, lockOrder } from './ton-row-locks';

// The checks of the signing transaction that read or write rows (TonTransferRepository runs them
// under its order -> attempt row locks). Kept apart so the repository stays one readable file.

export type Gate = { readonly ok: true } | { readonly ok: false; readonly reason: TonStopReason };

/** Order PROCESSING, attempt SENDING of that order, no reference and no transfer yet. */
export async function gate(tx: Tx, orderId: string, attemptId: string): Promise<Gate> {
  const order = await lockOrder(tx, orderId);
  const attempt = await lockAttempt(tx, attemptId);
  if (order?.status !== 'PROCESSING') return { ok: false, reason: 'ORDER_NOT_PROCESSING' };
  if (attempt?.orderId !== orderId || attempt.status !== 'SENDING') {
    return { ok: false, reason: 'ATTEMPT_NOT_SENDING' };
  }
  if (attempt.externalRef !== null) return { ok: false, reason: 'REF_TAKEN' };
  const transfer = await tx.tonTransfer.findUnique({ where: { attemptId }, select: { id: true } });
  if (transfer !== null) return { ok: false, reason: 'ATTEMPT_HAS_TRANSFER' };
  return { ok: true };
}

/** Why an attempt was refused before signing, in `FulfillmentAttempt.error` (free text column). */
export type HoldError = TonHoldReason | 'PAY_ADDRESS_NOT_ALLOWED';

/**
 * The order reason a hold is stored with. A payout address outside FRAGMENT_PAY_ADDRESSES is an
 * adapter fault (the closed reason list has no better word, audit L1); the attempt's `error`
 * says which one.
 */
export function holdReasonOf(error: HoldError): TonHoldReason {
  return error === 'PAY_ADDRESS_NOT_ALLOWED' ? 'ADAPTER_ERROR' : error;
}

/** Nothing was signed: the attempt fails (no transfer) and the order is held with the reason. */
export async function hold(
  tx: Tx,
  orderId: string,
  attemptId: string,
  error: HoldError,
): Promise<void> {
  const reason = holdReasonOf(error);
  await tx.fulfillmentAttempt.update({
    where: { id: attemptId },
    data: { status: 'FAILED', error },
  });
  await transitionOrder(tx, {
    orderId,
    from: 'PROCESSING',
    to: 'HELD',
    actor: 'system',
    reason,
    note: 'ton: refused before signing',
  });
}

/**
 * The rolling 24 h payout sum of the wallet (plan 6.6 step 7), by the database clock. EVERY
 * transfer counts, the EXPIRED ones included (audit L5: an EXPIRED verdict rests on one provider
 * until the second source exists, so the limit takes the safe side), the bounced and failed ones
 * too. Read inside the signing transaction, after the wallet's unresolved slot was found free, so
 * two payouts are never summed in parallel.
 */
export async function spentLast24h(
  tx: Tx,
  network: string,
  walletAddress: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM("amountNanoTon"), 0)::text AS "total" FROM "TonTransfer"
    WHERE "network" = ${network} AND "walletAddress" = ${walletAddress}
      AND "createdAt" > timezone('UTC', now()) - interval '24 hours'`;
  return BigInt(rows[0]?.total ?? '0');
}

/**
 * How far the signing transaction's own clock (`now()`, which becomes the transfer's `createdAt`)
 * is ahead of the chain time the message is signed at, in whole seconds. The scan window of the
 * confirmation starts at `createdAt` minus scanSlackSec, so a lag above signLagMaxSec could leave
 * our own transaction outside it (review m5: a false CONSUMED_UNMATCHED).
 */
export async function databaseLagSec(tx: Tx, chainTimeSec: number): Promise<number> {
  const rows = await tx.$queryRaw<{ s: string }[]>`
    SELECT floor(extract(epoch from now()))::bigint::text AS "s"`;
  const nowSec = Number(rows[0]?.s);
  if (!Number.isSafeInteger(nowSec)) throw new Error('the database clock could not be read');
  return nowSec - chainTimeSec;
}
