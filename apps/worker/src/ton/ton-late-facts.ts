import type { Prisma } from '@repo/db';
import type { TransferFacts } from './ton-classifier';
import type { TonTxRef } from './ton-gateway';
import type { LateTransfer } from './ton-late.repository';
import { ONCHAIN_FAILED_DETAILS } from './ton-onchain-failed';

// Small readers of the late chain facts (phase 5 S9f): the signed message of a transfer as the
// classifier takes it, and the SUSPECT fact S5 kept on the attempt.

export function factsOf(t: LateTransfer): TransferFacts {
  return {
    seqno: t.seqno,
    validUntilSec: Math.floor(t.validUntil.getTime() / 1_000),
    toAddress: t.toAddress,
    amountNano: t.amountNanoTon,
    payloadHash: t.payloadHash,
  };
}

function objectOf(value: Prisma.JsonValue | undefined | null): Prisma.JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * The transaction of the attempt's SUSPECT fact when its detail is one whose transaction sends
 * nothing (NO_OUT_MESSAGE, ACTION_FAILED); null for any other fact or none.
 */
export function failedSuspectOf(response: Prisma.JsonValue | null): TonTxRef | null {
  const suspect = objectOf(objectOf(objectOf(response)?.['ton'])?.['suspect']);
  if (suspect === null) return null;
  const { detail, txHash, txLt } = suspect;
  if (!ONCHAIN_FAILED_DETAILS.some((d) => d === detail)) return null;
  if (typeof txHash !== 'string' || typeof txLt !== 'string' || !/^\d{1,20}$/.test(txLt)) {
    return null;
  }
  return { hash: txHash, lt: BigInt(txLt) };
}
