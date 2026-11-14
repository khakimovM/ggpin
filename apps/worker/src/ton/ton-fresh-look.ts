import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import type { Address } from '@ton/core';
import { classifyNotFound, type TransferFacts } from './ton-classifier';
import type { ExpiryObservation } from './ton-expiry';
import type { TonAccountState, TonChainWitness, TonTxRef } from './ton-gateway';
import type { StoredTransfer } from './ton-transfer.repository';
import { headIs, sameRef } from './ton-tx-scan';
import { seqnoOf, type W5Data } from './ton-w5';

// Audit M-1 (b): one provider can keep answering from a stale node for as long as our client
// keeps its kept-alive socket to that node, and two "consistent" stale answers 30 s apart used to
// make a false EXPIRED (and a second payment). So an EXPIRY observation is taken again over a NEW
// connection (no kept-alive socket: toncenter-http `fresh`), which may reach another node behind
// the provider's balancer. It stands only when that connection sees the state the scan rested on
// (the same last transaction, nothing newer in its own index: M-1 (a) again), the seqno still
// ours, the chain time past validUntil + the margin, and the database clock read right after it
// past that point too. The observation records THAT state's chain time and THAT clock reading.
// Cost: two reads, only on a look whose scan already pointed at an expiry (a lost message).

function sameLast(a: TonTxRef | null, b: TonTxRef | null): boolean {
  if (a === null || b === null) return a === b;
  return sameRef(a, b);
}

export interface FreshLook {
  readonly connection: TonChainWitness;
  readonly own: W5Data;
  readonly transfer: StoredTransfer;
  readonly facts: TransferFacts;
  readonly address: Address;
  /** The state the COMPLETE scan rested on (read over the kept-alive connection). */
  readonly anchor: TonAccountState;
  readonly databaseNowMs: () => Promise<number>;
}

/** The observation, or null when the new connection does not see the same expired message. */
export async function freshObservation(look: FreshLook): Promise<ExpiryObservation | null> {
  const { connection, transfer, address } = look;
  const state = await connection.getAccountState(address);
  const atMs = await look.databaseNowMs();
  const last = state.lastTx;
  if (!sameLast(last, look.anchor.lastTx)) return null;
  if (!headIs(await connection.getTransactions(address, { limit: 1 }), last)) return null;
  const seqno = seqnoOf(state, look.own);
  if (classifyNotFound(look.facts, seqno, state.chainTime).kind !== 'EXPIRY_CANDIDATE') return null;
  // The guard of migration 10 refuses EXPIRED before validUntil + the margin by the DB clock.
  const validUntilMs = transfer.validUntil.getTime();
  if (atMs < validUntilMs + TON_NOT_SENT_MARGIN_MS) return null;
  return {
    transferId: transfer.id,
    extMsgHash: transfer.extMsgHash,
    validUntilMs,
    chainTime: state.chainTime,
    atMs,
    seqno: look.facts.seqno,
    lastTxLt: last?.lt ?? 0n,
  };
}
