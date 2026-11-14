import type { Address, Transaction } from '@ton/core';

// What the TON module needs from the chain (plan S5). Two implementations: ToncenterGateway (the
// real network, built ONLY with FULFILLMENT_DRY_RUN=false) and FakeTonGateway (dev and tests, an
// in-memory chain that refuses to exist in production or with DRY_RUN=false). Hashes are 64
// lowercase hex, logical times bigint, times unix seconds of the chain.
//
// The plan's `getSeqno` is `getAccountState`: the wallet's seqno lives in its data cell, and it is
// read from the SAME answer as the chain time and the last transaction, so a "seqno did not move by
// time T" proof never mixes two snapshots (plan 6.5).

export interface TonTxRef {
  readonly lt: bigint;
  readonly hash: string;
}

export interface TonAccountState {
  readonly status: 'active' | 'uninitialized' | 'frozen';
  readonly balanceNano: bigint;
  /** The account's data cell as a BOC (the W5 seqno is read from it); null when not active. */
  readonly data: Buffer | null;
  /** The chain time (unix seconds) of the block this state was read at. */
  readonly chainTime: number;
  /** The account's last transaction at that block; null for an account without any. */
  readonly lastTx: TonTxRef | null;
}

/**
 * One page of an account's transactions, newest first. With `at` the page starts AT that
 * transaction (inclusive): the scan walks the account's own chain of transactions down from a
 * known one, so a listing that skips or invents a transaction is caught (ton-tx-scan.ts).
 */
export interface TxPage {
  readonly limit: number;
  readonly at?: TonTxRef;
}

/**
 * The reads one EXPIRY observation rests on (review m3): an account state and the account's
 * transactions. A second chain source (TON_EXPIRY_WITNESSES, S12) and a fresh connection of the
 * primary source (audit M-1 (b)) offer exactly these, nothing that sends or pays.
 */
export interface TonChainWitness {
  getAccountState(address: Address): Promise<TonAccountState>;
  getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]>;
}

export interface TonGateway extends TonChainWitness {
  getBalance(address: Address): Promise<bigint>;
  /** Hands a signed external message to the network. A throw does NOT mean "not sent". */
  sendBoc(boc: Buffer): Promise<void>;
  /**
   * The same provider over a NEW connection (no keep-alive): a backend node that lags behind a
   * load balancer keeps answering a kept-alive connection, so the reads that confirm an EXPIRY
   * observation go through a connection of their own (audit M-1 (b)).
   */
  freshConnection(): TonChainWitness;
  /**
   * The destination's transaction that processed the message `source` created at `createdLt`.
   * Null ONLY for the provider's recognised "not found" answer; every other failure throws a
   * TonGatewayError (fail-closed: an error never reads as "not there").
   */
  findResultTx(
    source: Address,
    destination: Address,
    createdLt: bigint,
  ): Promise<Transaction | null>;
}

export type TonGatewayOperation = keyof TonGateway;

/**
 * A chain call that failed. The message names the operation and a coarse reason only: the HTTP
 * client's own errors can carry the request headers (the API key) or the response body, so they
 * never pass through (redaction, plan §11).
 */
export class TonGatewayError extends Error {
  constructor(
    readonly operation: TonGatewayOperation,
    readonly reason: 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'MALFORMED' | 'REFUSED',
  ) {
    super(`TON gateway ${operation} failed (${reason})`);
    this.name = 'TonGatewayError';
  }
}
