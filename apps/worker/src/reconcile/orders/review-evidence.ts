import type { AttemptStatus, Prisma, TonTransferStatus } from '@repo/db';
import { RECONCILER_PROOF_REASON, TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { storedExpiryPair } from '../../ton/ton-expiry';
import { hasWitnessConflict } from '../../ton/ton-row-locks';

// What the stored chain evidence of ONE NEEDS_REVIEW order allows the reconciler to do (phase 5
// S9, D-64 (2), plan §4.4). Pure: the rows are read by the caller, the proof goes to
// `resolveNeedsReview`, which binds it to the rows again under lock. Only two proofs exist here:
// - TON_TX -> DELIVERED: exactly one transfer is CONFIRMED (with its transaction), every other one
//   is EXPIRED, and its attempt is the only unresolved one;
// - TON_NOT_SENT -> FAILED + REFUND: EVERY transfer is EXPIRED and every one of them carries the
//   two observations the TON module wrote it EXPIRED on (D-60 (2)), bound to that very transfer.
// Anything else stays with the owner: a witness conflict or a suspect transaction ever recorded,
// a transfer still unresolved, BOUNCED or ONCHAIN_FAILED, an unresolved attempt without a transfer
// (a supplier's, or a SENDING one that never signed: Q-18), a transfer of another wallet or
// network. CONSUMED_UNMATCHED only raises its alert.

export interface ReviewTransfer {
  readonly id: string;
  readonly purpose: string;
  readonly network: string;
  readonly walletAddress: string;
  readonly seqno: number;
  readonly validUntil: Date;
  readonly extMsgHash: string;
  readonly status: TonTransferStatus;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
}

export interface ReviewAttempt {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly response: Prisma.JsonValue | null;
  readonly transfer: ReviewTransfer | null;
}

/** The hot wallet this worker reads, and the gap the TON module demanded between observations. */
export interface EvidenceContext {
  readonly network: string;
  readonly walletAddress: string;
  readonly expiryGapSec: number;
}

export type SkipReason =
  | 'NO_TRANSFER'
  | 'FOREIGN_TRANSFER'
  | 'WITNESS_CONFLICT'
  | 'SUSPECT'
  | 'TRANSFERLESS_ATTEMPT'
  | 'CONFIRMED_ATTEMPT'
  | 'NOT_PROVABLE';

export interface TonTxProof {
  readonly kind: 'TON_TX';
  readonly extMsgHash: string;
  readonly walletAddress: string;
  readonly txHash: string;
  readonly lt: string;
  readonly reason: string;
}

export interface TonNotSentProof {
  readonly kind: 'TON_NOT_SENT';
  readonly extMsgHash: string;
  readonly walletAddress: string;
  readonly seqno: number;
  readonly validUntil: string;
  readonly checkedSeqno: number;
  readonly checkedAt: string;
  readonly reason: string;
}

export type ReviewDecision =
  | { readonly kind: 'SKIP'; readonly reason: SkipReason }
  | { readonly kind: 'ALERT_CONSUMED'; readonly transferId: string }
  | { readonly kind: 'DELIVER'; readonly transferId: string; readonly proof: TonTxProof }
  | { readonly kind: 'REFUND'; readonly transferId: string; readonly proof: TonNotSentProof };

const UNRESOLVED_ATTEMPT: readonly AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN'];

function isUnresolvedAttempt(attempt: ReviewAttempt): boolean {
  return UNRESOLVED_ATTEMPT.includes(attempt.status);
}

function hasSuspect(response: Prisma.JsonValue | null): boolean {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return false;
  const ton = response['ton'];
  if (typeof ton !== 'object' || ton === null || Array.isArray(ton)) return false;
  const fact = ton['suspect'];
  return fact !== undefined && fact !== null;
}

function skip(reason: SkipReason): ReviewDecision {
  return { kind: 'SKIP', reason };
}

type WithTransfer = ReviewAttempt & { readonly transfer: ReviewTransfer };

function deliver(own: WithTransfer, unresolved: readonly ReviewAttempt[]): ReviewDecision {
  const transfer = own.transfer;
  if (!isUnresolvedAttempt(own) || unresolved.some((a) => a.id !== own.id)) {
    return skip('NOT_PROVABLE');
  }
  if (transfer.txHash === null || transfer.txLt === null) return skip('NOT_PROVABLE');
  return {
    kind: 'DELIVER',
    transferId: transfer.id,
    proof: {
      kind: 'TON_TX',
      extMsgHash: transfer.extMsgHash,
      walletAddress: transfer.walletAddress,
      txHash: transfer.txHash,
      lt: transfer.txLt.toString(),
      reason: RECONCILER_PROOF_REASON,
    },
  };
}

function refund(
  paid: readonly WithTransfer[],
  unresolved: readonly ReviewAttempt[],
  gapSec: number,
): ReviewDecision {
  let chosen: { attempt: WithTransfer; checkedSeqno: number; checkedAtMs: number } | null = null;
  for (const attempt of paid) {
    const transfer = attempt.transfer;
    const pair = storedExpiryPair(attempt.response, transfer, gapSec);
    const sinceMs = transfer.validUntil.getTime() + TON_NOT_SENT_MARGIN_MS;
    if (pair === null || pair.second.atMs < sinceMs) return skip('NOT_PROVABLE');
    const candidate = { attempt, checkedSeqno: pair.second.seqno, checkedAtMs: pair.second.atMs };
    // The proof names the transfer of the one unresolved attempt; with none, the latest message.
    const own = unresolved.length === 1 && unresolved[0]?.id === attempt.id;
    if (
      chosen === null ||
      own ||
      (unresolved.length === 0 && transfer.validUntil > chosen.attempt.transfer.validUntil)
    ) {
      chosen = candidate;
    }
  }
  const picked = chosen;
  if (picked === null) return skip('NO_TRANSFER');
  if (unresolved.some((a) => a.id !== picked.attempt.id)) return skip('NOT_PROVABLE');
  const transfer = picked.attempt.transfer;
  return {
    kind: 'REFUND',
    transferId: transfer.id,
    proof: {
      kind: 'TON_NOT_SENT',
      extMsgHash: transfer.extMsgHash,
      walletAddress: transfer.walletAddress,
      seqno: transfer.seqno,
      validUntil: transfer.validUntil.toISOString(),
      checkedSeqno: picked.checkedSeqno,
      checkedAt: new Date(picked.checkedAtMs).toISOString(),
      reason: RECONCILER_PROOF_REASON,
    },
  };
}

/**
 * The CONSUMED_UNMATCHED transfers of the order (audit I-2): only the owner can say where that
 * seqno's value went, whatever else the evidence says (a witness conflict, a suspect transaction,
 * an attempt without a transfer), so the reminder never depends on the decision.
 */
export function consumedTransferIds(attempts: readonly ReviewAttempt[]): string[] {
  return attempts.flatMap((a) =>
    a.transfer !== null && a.transfer.status === 'CONSUMED_UNMATCHED' ? [a.transfer.id] : [],
  );
}

export function decideReview(
  attempts: readonly ReviewAttempt[],
  context: EvidenceContext,
): ReviewDecision {
  const paid = attempts.filter((a): a is WithTransfer => a.transfer !== null);
  if (paid.length === 0) return skip('NO_TRANSFER');
  const foreign = paid.some(
    ({ transfer }) =>
      transfer.purpose !== 'ORDER' ||
      transfer.network !== context.network ||
      transfer.walletAddress !== context.walletAddress,
  );
  if (foreign) return skip('FOREIGN_TRANSFER');
  if (attempts.some((a) => hasWitnessConflict(a.response))) return skip('WITNESS_CONFLICT');
  if (attempts.some((a) => hasSuspect(a.response))) return skip('SUSPECT');
  const unresolved = attempts.filter(isUnresolvedAttempt);
  if (unresolved.some((a) => a.transfer === null)) return skip('TRANSFERLESS_ATTEMPT');
  if (attempts.some((a) => a.status === 'CONFIRMED')) return skip('CONFIRMED_ATTEMPT');
  const consumed = paid.find((a) => a.transfer.status === 'CONSUMED_UNMATCHED');
  if (consumed !== undefined) return { kind: 'ALERT_CONSUMED', transferId: consumed.transfer.id };
  const confirmed = paid.filter((a) => a.transfer.status === 'CONFIRMED');
  const [onlyConfirmed] = confirmed;
  if (
    confirmed.length === 1 &&
    onlyConfirmed !== undefined &&
    paid.every((a) => a.id === onlyConfirmed.id || a.transfer.status === 'EXPIRED')
  ) {
    return deliver(onlyConfirmed, unresolved);
  }
  if (paid.every((a) => a.transfer.status === 'EXPIRED')) {
    return refund(paid, unresolved, context.expiryGapSec);
  }
  return skip('NOT_PROVABLE');
}

/**
 * The evidence a decision rests on, as one comparable string: every transfer's status and
 * transaction, and every attempt's recorded chain facts (conflict, suspect, expiry pair). Read again
 * inside the resolving transaction, after `resolveNeedsReview` locked the rows: when it differs from
 * what the decision was made on, the transaction is rolled back (attempt statuses are left out: the
 * resolution itself closes them).
 */
export function evidenceKey(attempts: readonly ReviewAttempt[]): string {
  return JSON.stringify(
    [...attempts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => {
        const ton =
          typeof a.response === 'object' && a.response !== null && !Array.isArray(a.response)
            ? (a.response['ton'] ?? null)
            : null;
        const facts =
          typeof ton === 'object' && ton !== null && !Array.isArray(ton)
            ? {
                expiry: ton['expiry'] ?? null,
                suspect: ton['suspect'] ?? null,
                witnessConflict: ton['witnessConflict'] ?? null,
              }
            : null;
        const t = a.transfer;
        return {
          id: a.id,
          facts,
          transfer:
            t === null
              ? null
              : [t.id, t.status, t.txHash, t.txLt === null ? null : t.txLt.toString()],
        };
      }),
  );
}
