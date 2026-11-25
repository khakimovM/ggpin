import type { Address, Transaction } from '@ton/core';
import { classifyOurTx, type SuspectDetail, type TransferFacts } from './ton-classifier';
import type { TonTxRef } from './ton-gateway';
import { ourTxFacts, type OurTxFacts } from './ton-tx-facts';
import { isOwnExternal, sameRef, txRef } from './ton-tx-scan';

// ONCHAIN_FAILED (phase 5 S9f, D-64 (7), Q-6, R2a): our message WAS executed, but the wallet's
// transaction sent nothing (the send was skipped, or the action phase failed), so no value left
// beyond the fee. S5 leaves such a transfer unresolved with a SUSPECT fact because one source is
// not enough. Here the transaction the SUSPECT fact names must be listed, at its (lt, hash), by the
// primary source AND by every expiry witness (at least one), each time as OUR external message's
// transaction with zero outgoing messages and the same compute / action / abort state. No witness,
// or any disagreement: nothing is proven, nothing is written. Pure: the caller reads the sources.

/** The SUSPECT details whose transaction sends nothing (classifier: ton-classifier.ts). */
export const ONCHAIN_FAILED_DETAILS: readonly SuspectDetail[] = ['NO_OUT_MESSAGE', 'ACTION_FAILED'];

export interface OnchainFailedEvidence {
  readonly wallet: Address;
  readonly extMsgHash: string;
  readonly transfer: TransferFacts;
  /** The transaction the stored SUSPECT fact names. */
  readonly recorded: TonTxRef;
  /** What the primary source listed first at `recorded`, or null. */
  readonly primary: Transaction | null;
  /** The same from every expiry witness. */
  readonly witnesses: readonly (Transaction | null)[];
}

export type OnchainFailedWhy =
  'NO_WITNESS' | 'NOT_FOUND' | 'WITNESS_DISAGREES' | 'NOT_OURS' | 'HAS_OUT_MESSAGE' | 'NOT_FAILED';

export type OnchainFailedCheck =
  | { readonly kind: 'PROVEN'; readonly tx: OurTxFacts; readonly sources: number }
  | { readonly kind: 'NOT_PROVEN'; readonly why: OnchainFailedWhy };

function notProven(why: OnchainFailedWhy): OnchainFailedCheck {
  return { kind: 'NOT_PROVEN', why };
}

function sameState(a: OurTxFacts, b: OurTxFacts): boolean {
  return (
    a.hash === b.hash &&
    a.lt === b.lt &&
    a.generic === b.generic &&
    a.computeOk === b.computeOk &&
    a.actionOk === b.actionOk &&
    a.aborted === b.aborted &&
    a.skippedActions === b.skippedActions
  );
}

/** Why one source's listing does not show our transaction that sent nothing; null when it does. */
function problemOf(e: OnchainFailedEvidence, tx: Transaction): OnchainFailedWhy | null {
  if (!isOwnExternal(tx, e.wallet, e.extMsgHash)) return 'NOT_OURS';
  if (tx.outMessagesCount !== 0 || tx.outMessages.size !== 0) return 'HAS_OUT_MESSAGE';
  const step = classifyOurTx(e.transfer, tx);
  if (step.kind !== 'SUSPECT' || !ONCHAIN_FAILED_DETAILS.includes(step.detail)) {
    return 'NOT_FAILED';
  }
  return null;
}

export function checkOnchainFailed(e: OnchainFailedEvidence): OnchainFailedCheck {
  if (e.witnesses.length === 0) return notProven('NO_WITNESS');
  let seen: OurTxFacts | null = null;
  for (const [index, tx] of [e.primary, ...e.witnesses].entries()) {
    if (tx === null || !sameRef(txRef(tx), e.recorded)) {
      return notProven(index === 0 ? 'NOT_FOUND' : 'WITNESS_DISAGREES');
    }
    const problem = problemOf(e, tx);
    if (problem !== null) return notProven(index === 0 ? problem : 'WITNESS_DISAGREES');
    const facts = ourTxFacts(tx);
    if (seen !== null && !sameState(seen, facts)) return notProven('WITNESS_DISAGREES');
    seen ??= facts;
  }
  if (seen === null) return notProven('NOT_FOUND');
  return { kind: 'PROVEN', tx: seen, sources: 1 + e.witnesses.length };
}
