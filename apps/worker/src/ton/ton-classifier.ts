import { TON_BOUNCE_FEE_MAX_NANO, TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import type { Transaction } from '@ton/core';
import type { ExpiryObservation } from './ton-expiry';
import {
  ourTxFacts,
  type BounceMessageFacts,
  type OurTxFacts,
  type OutMessageFacts,
  type ReturnTxFacts,
} from './ton-tx-facts';

// The pure decision about one signed message (plan 6.5, docs/06 "5-faza S1", D-59, D-60). Sources:
// the state machine of migration 10 and the @ton/core transaction types; nothing here is a guess
// about a provider's answer. The rules, in order:
//
// - our message found in the wallet's transactions -> look at OUR transaction:
//   * it paid exactly one internal message to `toAddress`, exactly `amountNano`, with the body
//     whose hash is `payloadHash` -> look at the destination (below);
//   * anything else (compute or action failed, nothing sent, another message) -> SUSPECT: the
//     order goes to NEEDS_REVIEW and the transfer is NOT marked ONCHAIN_FAILED here, because that
//     state needs a second, independent source (R2a); the reconciler (S9) does it;
// - the destination processed it -> CONFIRMED; it aborted and its bounce came back to us (the
//   return transaction is found, the value within TON_BOUNCE_FEE_MAX_NANO of what we sent) ->
//   BOUNCED; it aborted without a bounce, or the return is out of that range -> SUSPECT; it is not
//   visible yet -> wait a grace period of chain time counted from the first SUCCESSFUL "not found"
//   answer, then CONFIRMED (D-56 (5), Q6; a later bounce is the reconciler's CONFIRMED -> BOUNCED);
//   the index answered with another transaction -> WAIT;
// - not found, the window read in full (a COMPLETE scan):
//   * the wallet seqno moved past ours -> CONSUMED_UNMATCHED (someone else used the seqno);
//   * the seqno did not move and the chain time is past validUntil + the margin -> one EXPIRY
//     observation (taken again over a new connection, audit M-1 (b)): EXPIRED itself needs two of
//     them, separated in time (D-60 (2), ton-expiry.ts); an expiry witness that finds our message
//     or a moved seqno -> WITNESS_CONFLICT (review m3): never EXPIRED, the order goes to review;
//   * otherwise -> WAIT (still in flight);
// - an incomplete or stale scan, an unreadable wallet -> WAIT. Nothing is decided without proof.

export interface TransferFacts {
  readonly seqno: number;
  readonly validUntilSec: number;
  readonly toAddress: string;
  readonly amountNano: bigint;
  readonly payloadHash: string;
}

export type WaitDetail =
  | 'GATEWAY'
  | 'INDEX_STALE'
  | 'INDEX_SCANNING'
  | 'WALLET_UNREADABLE'
  | 'SEQNO_BEHIND'
  | 'IN_FLIGHT'
  | 'DESTINATION_PENDING'
  | 'DESTINATION_MISMATCH'
  | 'BOUNCE_RETURN_PENDING'
  | 'DB_CLOCK_BEHIND'
  /** A new connection did not see the same state (M-1 (b)): no observation from this look. */
  | 'FRESH_DISAGREES'
  | 'WITNESS_PENDING';

/** What an expiry witness saw instead of agreeing: our message, or the seqno used. */
export type WitnessConflictDetail = 'FOUND' | 'SEQNO_MOVED';

export type SuspectDetail =
  | 'NOT_GENERIC'
  | 'COMPUTE_FAILED'
  | 'ACTION_FAILED'
  | 'NO_OUT_MESSAGE'
  | 'OUT_MESSAGE_COUNT'
  | 'OUT_MESSAGE_MISMATCH'
  | 'DESTINATION_ABORTED'
  | 'RETURN_ABOVE_SENT'
  | 'RETURN_BELOW_FLOOR';

export type TonVerdict =
  | { readonly kind: 'CONFIRMED'; readonly tx: OurTxFacts }
  | { readonly kind: 'BOUNCED'; readonly tx: OurTxFacts; readonly returnTx: ReturnTxFacts }
  /** One proof that the message can no longer be accepted; EXPIRED needs a second one later. */
  | { readonly kind: 'EXPIRY_SEEN'; readonly observation: ExpiryObservation }
  | { readonly kind: 'CONSUMED_UNMATCHED'; readonly walletSeqno: number }
  | { readonly kind: 'SUSPECT'; readonly tx: OurTxFacts; readonly detail: SuspectDetail }
  /** `witness` is the index of the witness in TON_EXPIRY_WITNESSES. */
  | {
      readonly kind: 'WITNESS_CONFLICT';
      readonly detail: WitnessConflictDetail;
      readonly witness: number;
    }
  | { readonly kind: 'WAIT'; readonly detail: WaitDetail };

export type NotFoundStep =
  /** Seqno unchanged and chain time past validUntil + the margin, at the anchor of the scan. */
  | { readonly kind: 'EXPIRY_CANDIDATE' }
  | Extract<TonVerdict, { readonly kind: 'CONSUMED_UNMATCHED' | 'WAIT' }>;

const MARGIN_SEC = Math.ceil(TON_NOT_SENT_MARGIN_MS / 1_000);

/** A COMPLETE scan did not find our message: what the state it was anchored at says. */
export function classifyNotFound(
  transfer: TransferFacts,
  walletSeqno: number | null,
  chainTime: number,
): NotFoundStep {
  if (walletSeqno === null) return { kind: 'WAIT', detail: 'WALLET_UNREADABLE' };
  if (walletSeqno > transfer.seqno) return { kind: 'CONSUMED_UNMATCHED', walletSeqno };
  // A seqno below the signed one contradicts the signing snapshot: a lagging node. No decision.
  if (walletSeqno < transfer.seqno) return { kind: 'WAIT', detail: 'SEQNO_BEHIND' };
  if (chainTime > transfer.validUntilSec + MARGIN_SEC) return { kind: 'EXPIRY_CANDIDATE' };
  return { kind: 'WAIT', detail: 'IN_FLIGHT' };
}

export type PaidStep =
  | { readonly kind: 'PAID'; readonly tx: OurTxFacts; readonly out: OutMessageFacts }
  | Extract<TonVerdict, { readonly kind: 'SUSPECT' }>;

/** Our transaction was found: did it pay out exactly the signed message? */
export function classifyOurTx(transfer: TransferFacts, tx: Transaction): PaidStep {
  const facts = ourTxFacts(tx);
  const suspect = (detail: SuspectDetail): PaidStep => ({ kind: 'SUSPECT', tx: facts, detail });
  if (!facts.generic) return suspect('NOT_GENERIC');
  if (!facts.computeOk) return suspect('COMPUTE_FAILED');
  if (facts.aborted || !facts.actionOk) return suspect('ACTION_FAILED');
  // External messages of a W5 wallet always carry IGNORE_ERRORS (+2): a send that failed (not
  // enough balance, say) is skipped and the transaction still succeeds with no outgoing message.
  if (facts.skippedActions > 0 || facts.outMessages.length === 0) return suspect('NO_OUT_MESSAGE');
  const [out, ...rest] = facts.outMessages;
  if (out === undefined || rest.length > 0) return suspect('OUT_MESSAGE_COUNT');
  if (
    out.dest !== transfer.toAddress ||
    out.valueNano !== transfer.amountNano ||
    out.bodyHash !== transfer.payloadHash
  ) {
    return suspect('OUT_MESSAGE_MISMATCH');
  }
  return { kind: 'PAID', tx: facts, out };
}

export type DestinationView =
  /** The lookup answered "not found"; `since` is the chain time of the first such answer. */
  | { readonly kind: 'NOT_VISIBLE'; readonly since: number }
  /** The lookup answered with a transaction that did not process our message. */
  | { readonly kind: 'MISMATCH' }
  | { readonly kind: 'PROCESSED' }
  | { readonly kind: 'ABORTED' }
  | {
      readonly kind: 'BOUNCED';
      readonly bounce: BounceMessageFacts;
      readonly returnTx: ReturnTxFacts | null;
    };

/** Our transaction paid out: what happened at the destination? */
export function classifyDestination(
  paid: Extract<PaidStep, { readonly kind: 'PAID' }>,
  destination: DestinationView,
  chainTime: number,
  graceSec: number,
): TonVerdict {
  switch (destination.kind) {
    case 'PROCESSED':
      return { kind: 'CONFIRMED', tx: paid.tx };
    case 'ABORTED':
      return { kind: 'SUSPECT', tx: paid.tx, detail: 'DESTINATION_ABORTED' };
    case 'MISMATCH':
      return { kind: 'WAIT', detail: 'DESTINATION_MISMATCH' };
    case 'NOT_VISIBLE': {
      // Only answers that really said "not found" count (an error is a WAIT before this point).
      const since = Math.max(paid.tx.utime, destination.since);
      return chainTime - since >= graceSec
        ? { kind: 'CONFIRMED', tx: paid.tx }
        : { kind: 'WAIT', detail: 'DESTINATION_PENDING' };
    }
    case 'BOUNCED': {
      // BOUNCED blocks DELIVERED for good, so it needs the return transaction itself, not only
      // the destination's word that it sent one back.
      const returnTx = destination.returnTx;
      if (returnTx === null) return { kind: 'WAIT', detail: 'BOUNCE_RETURN_PENDING' };
      if (returnTx.returnedNano > paid.out.valueNano) {
        return { kind: 'SUSPECT', tx: paid.tx, detail: 'RETURN_ABOVE_SENT' };
      }
      // The owner's TON_BOUNCED proof accepts [sent - TON_BOUNCE_FEE_MAX_NANO, sent] only (S1,
      // review-proof.ts): below that "the money came back" is not proven, and a BOUNCED transfer
      // that can never be failed would leave the order with no way out (review M2).
      if (returnTx.returnedNano < paid.out.valueNano - TON_BOUNCE_FEE_MAX_NANO) {
        return { kind: 'SUSPECT', tx: paid.tx, detail: 'RETURN_BELOW_FLOOR' };
      }
      return { kind: 'BOUNCED', tx: paid.tx, returnTx };
    }
  }
}
