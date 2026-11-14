import { isDeepStrictEqual } from 'node:util';
import { transitionOrder, type Prisma, type TonTransferStatus, type Tx } from '@repo/db';
import type { SuspectDetail, WitnessConflictDetail } from './ton-classifier';
import {
  confirmsExpiry,
  isFirstFor,
  observationJson,
  storedFirstObservation,
  type ExpiryObservation,
} from './ton-expiry';
import {
  hasWitnessConflict,
  withTonFacts,
  type LockedAttempt,
  type LockedOrder,
} from './ton-row-locks';
import type { OurTxFacts, ReturnTxFacts } from './ton-tx-facts';

// The writes of TonOutcomeRepository, on rows it has already locked (order -> attempt -> transfer).
// Each returns whether anything changed: a repeated SUSPECT or TIMEOUT of a transfer that stays
// unresolved writes nothing the second time (review n3), and one EXPIRY observation either keeps
// the first one, waits for a later one, or (the second, D-60 (2)) writes EXPIRED. Never after a
// WITNESS_CONFLICT (review RR2-4): one of the two sources has lied about this very transfer, so
// "not sent" is no longer provable by looking again; the reconciler or the owner decides it.

export type TonOutcome =
  | { readonly kind: 'CONFIRMED'; readonly tx: OurTxFacts }
  | { readonly kind: 'BOUNCED'; readonly tx: OurTxFacts; readonly returnTx: ReturnTxFacts }
  | {
      readonly kind: 'EXPIRY_SEEN';
      readonly observation: ExpiryObservation;
      readonly gapSec: number;
    }
  | { readonly kind: 'CONSUMED_UNMATCHED'; readonly walletSeqno: number }
  | { readonly kind: 'SUSPECT'; readonly tx: OurTxFacts; readonly detail: SuspectDetail }
  /** An expiry witness saw our message or a moved seqno (review m3): never EXPIRED, a human. */
  | {
      readonly kind: 'WITNESS_CONFLICT';
      readonly detail: WitnessConflictDetail;
      readonly witness: number;
    }
  | { readonly kind: 'TIMEOUT' };

export interface OutcomeRows {
  readonly transferId: string;
  readonly transfer: TonTransferStatus;
  readonly orderId: string | null;
  readonly order: LockedOrder | null;
  readonly attemptId: string | null;
  readonly attempt: LockedAttempt | null;
}

/** What a transfer without an attempt (SELFTEST) needs kept, by the one CLI process watching it. */
export interface SelftestExpiryMemory {
  /** First observations (D-60 (2)). */
  readonly firsts: Map<string, ExpiryObservation>;
  /** Transfers an expiry witness contradicted (review RR2-4): never EXPIRED in this process. */
  readonly conflicts: Set<string>;
}

function isLive(attempt: LockedAttempt | null): attempt is LockedAttempt {
  return attempt?.status === 'SENDING' || attempt?.status === 'SENT';
}

function chainFields(tx: OurTxFacts) {
  return {
    txHash: tx.hash,
    txLt: tx.lt,
    feeNanoTon: tx.feeNano,
    confirmedAt: new Date(tx.utime * 1_000),
  };
}

function txFacts(tx: OurTxFacts): Prisma.InputJsonObject {
  return { txHash: tx.hash, txLt: tx.lt.toString(), feeNanoTon: tx.feeNano.toString() };
}

function tonPart(response: Prisma.JsonValue | null): Prisma.JsonValue | undefined {
  if (typeof response !== 'object' || response === null || Array.isArray(response))
    return undefined;
  return response['ton'];
}

/**
 * The attempt already holds exactly these facts. Compared by value, not by text: jsonb stores the
 * keys of an object in its own order, and a deep comparison does not depend on the key order.
 */
function hasFacts(attempt: LockedAttempt, facts: Prisma.InputJsonObject): boolean {
  const ton = tonPart(attempt.response);
  if (typeof ton !== 'object' || ton === null || Array.isArray(ton)) return false;
  return Object.entries(facts).every(([key, value]) => isDeepStrictEqual(ton[key], value));
}

/** Attempt CONFIRMED and order DELIVERED, only for an order still PROCESSING (N1-B). */
async function deliver(tx: Tx, rows: OutcomeRows, ourTx: OurTxFacts): Promise<void> {
  if (rows.order?.status !== 'PROCESSING' || rows.orderId === null) return;
  if (!isLive(rows.attempt) || rows.attemptId === null) return;
  await tx.fulfillmentAttempt.update({
    where: { id: rows.attemptId },
    data: { status: 'CONFIRMED', response: withTonFacts(rows.attempt.response, txFacts(ourTx)) },
  });
  await transitionOrder(tx, {
    orderId: rows.orderId,
    from: 'PROCESSING',
    to: 'DELIVERED',
    actor: 'system',
    note: `ton transfer ${rows.transferId}`,
  });
}

/** The outcome is not ours to decide: attempt UNKNOWN with the facts, order NEEDS_REVIEW. */
async function review(
  tx: Tx,
  rows: OutcomeRows,
  reason: 'ADAPTER_ERROR' | 'CONFIRM_TIMEOUT',
  facts: Prisma.InputJsonObject,
): Promise<boolean> {
  let changed = false;
  const attempt = rows.attempt;
  const open = attempt?.status === 'SENDING' || attempt?.status === 'SENT';
  const recorded = attempt !== null && attempt.status === 'UNKNOWN' && hasFacts(attempt, facts);
  if (attempt !== null && rows.attemptId !== null && (open || attempt.status === 'UNKNOWN')) {
    if (!recorded) {
      await tx.fulfillmentAttempt.update({
        where: { id: rows.attemptId },
        data: { status: 'UNKNOWN', response: withTonFacts(attempt.response, facts) },
      });
      changed = true;
    }
  }
  if (rows.order?.status !== 'PROCESSING' || rows.orderId === null) return changed;
  await transitionOrder(tx, {
    orderId: rows.orderId,
    from: 'PROCESSING',
    to: 'NEEDS_REVIEW',
    actor: 'system',
    reason,
    note: `ton transfer ${rows.transferId}`,
  });
  return true;
}

/** SIGNED -> X is not an edge for an executed message: it evidently went out (BROADCAST first). */
async function markExecuted(tx: Tx, rows: OutcomeRows): Promise<boolean> {
  if (rows.transfer !== 'SIGNED') return false;
  await tx.tonTransfer.update({ where: { id: rows.transferId }, data: { status: 'BROADCAST' } });
  return true;
}

async function expiry(
  tx: Tx,
  rows: OutcomeRows,
  outcome: Extract<TonOutcome, { readonly kind: 'EXPIRY_SEEN' }>,
  memory: SelftestExpiryMemory,
): Promise<boolean> {
  const attempt = rows.attempt;
  const second = outcome.observation;
  if (second.transferId !== rows.transferId) throw new Error('an observation of another transfer');
  // Review RR2-4: after a witness conflict nothing is written, not even a first observation.
  if (
    attempt === null ? memory.conflicts.has(rows.transferId) : hasWitnessConflict(attempt.response)
  )
    return false;
  // Audit L-3: a kept first that is not about this very message is no first at all.
  const remembered = memory.firsts.get(rows.transferId);
  const first =
    attempt === null
      ? remembered !== undefined && isFirstFor(remembered, second)
        ? remembered
        : null
      : storedFirstObservation(attempt.response, second);
  if (first === null) {
    if (attempt === null || rows.attemptId === null) {
      memory.firsts.set(rows.transferId, second);
      return false;
    }
    await tx.fulfillmentAttempt.update({
      where: { id: rows.attemptId },
      data: {
        response: withTonFacts(attempt.response, { expiry: { first: observationJson(second) } }),
      },
    });
    return true;
  }
  if (!confirmsExpiry(first, second, outcome.gapSec)) return false;
  await tx.tonTransfer.update({ where: { id: rows.transferId }, data: { status: 'EXPIRED' } });
  memory.firsts.delete(rows.transferId);
  if (attempt === null || rows.attemptId === null) return true;
  const proof = { expiry: { first: observationJson(first), second: observationJson(second) } };
  const fail = rows.order?.status === 'PROCESSING' && isLive(attempt);
  await tx.fulfillmentAttempt.update({
    where: { id: rows.attemptId },
    data: {
      response: withTonFacts(attempt.response, proof),
      ...(fail ? { status: 'FAILED' as const, error: 'TON_EXPIRED' } : {}),
    },
  });
  return true;
}

export async function writeOutcome(
  tx: Tx,
  rows: OutcomeRows,
  outcome: TonOutcome,
  memory: SelftestExpiryMemory,
): Promise<boolean> {
  const where = { id: rows.transferId };
  switch (outcome.kind) {
    case 'CONFIRMED':
      await tx.tonTransfer.update({
        where,
        data: { status: 'CONFIRMED', ...chainFields(outcome.tx) },
      });
      await deliver(tx, rows, outcome.tx);
      return true;
    case 'BOUNCED':
      await markExecuted(tx, rows);
      await tx.tonTransfer.update({
        where,
        data: { status: 'BOUNCED', ...chainFields(outcome.tx) },
      });
      // What the owner's TON_BOUNCED proof needs (S10), kept on the attempt; money as strings.
      await review(tx, rows, 'ADAPTER_ERROR', {
        bounce: {
          ...txFacts(outcome.tx),
          returnTxHash: outcome.returnTx.hash,
          returnLt: outcome.returnTx.lt.toString(),
          returnedNanoTon: outcome.returnTx.returnedNano.toString(),
          destinationTxHash: outcome.returnTx.destTxHash,
        },
      });
      return true;
    case 'CONSUMED_UNMATCHED':
      await tx.tonTransfer.update({ where, data: { status: 'CONSUMED_UNMATCHED' } });
      await review(tx, rows, 'ADAPTER_ERROR', {
        consumedUnmatched: { walletSeqno: outcome.walletSeqno },
      });
      return true;
    case 'EXPIRY_SEEN':
      return expiry(tx, rows, outcome, memory);
    case 'SUSPECT': {
      const executed = await markExecuted(tx, rows);
      const reviewed = await review(tx, rows, 'ADAPTER_ERROR', {
        suspect: { detail: outcome.detail, ...txFacts(outcome.tx) },
      });
      return executed || reviewed;
    }
    case 'WITNESS_CONFLICT':
      if (rows.attempt === null) {
        memory.firsts.delete(rows.transferId);
        memory.conflicts.add(rows.transferId);
      }
      return review(tx, rows, 'ADAPTER_ERROR', {
        witnessConflict: { detail: outcome.detail, witness: outcome.witness },
      });
    case 'TIMEOUT':
      return review(tx, rows, 'CONFIRM_TIMEOUT', { timeout: true });
  }
}
