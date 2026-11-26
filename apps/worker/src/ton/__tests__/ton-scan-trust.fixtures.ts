import { randomBytes } from 'node:crypto';
import { Address, beginCell, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { rawAddress } from '../ton-address';
import { TonChainReader } from '../ton-chain-reader';
import type { TonVerdict } from '../ton-classifier';
import {
  TonGatewayError,
  type TonAccountState,
  type TonChainWitness,
  type TxPage,
} from '../ton-gateway';
import type { TonTiming } from '../ton-tokens';
import type { StoredTransfer } from '../ton-transfer.repository';
import { sameRef, txRef } from '../ton-tx-scan';
import { dryRunTonWallet } from '../ton-wallet';

// Sources for the scan trust specs (ton-scan-trust-reader.spec.ts, ton-scan-trust-floor.spec.ts):
// a node or a witness that serves an older snapshot of the wallet (state AND listing) with the
// current chain time, the way a lagging or lying provider would.

export const TON = 1_000_000_000n;
export const T0 = 1_800_000_000;
/** Well past validUntil (T0 + 60) and the margin: a look here may offer an EXPIRY observation. */
export const PAST = T0 + 200;
export const TRUST_TIMING: TonTiming = {
  pollMs: 10,
  destGraceSec: 20,
  confirmTimeoutMs: 300_000,
  lockTtlMs: 120_000,
  maxClockSkewSec: 60,
  expiryGapSec: 30,
};

export const hash = (byte: string): string => byte.repeat(32);

export interface Snapshot {
  readonly state: TonAccountState;
  readonly txs: readonly Transaction[];
}

/**
 * A listing of a recorded chain, newest first, from `at` down. A cursor the snapshot does not
 * hold is answered as FakeTonGateway.unknownCursor says ('ERROR': toncenter's ASSUMED answer,
 * TAXMIN until the S12 testnet fixture).
 */
function listing(
  txs: readonly Transaction[],
  page: TxPage,
  unknownCursor: 'BELOW' | 'ERROR',
): readonly Transaction[] {
  const at = page.at;
  const newestFirst = [...txs].reverse();
  if (at !== undefined && unknownCursor === 'ERROR') {
    if (!newestFirst.some((tx) => sameRef(txRef(tx), at))) {
      throw new TonGatewayError('getTransactions', 'HTTP');
    }
  }
  return newestFirst.filter((tx) => at === undefined || tx.lt <= at.lt).slice(0, page.limit);
}

/**
 * The primary source: `frozen` makes it serve an older snapshot, and `emptyListings` answers that
 * many listings from a cursor with nothing (a lagging index).
 */
export class LaggingNode extends FakeTonGateway {
  frozen: Snapshot | null = null;
  emptyListings = 0;

  realState(address: Address): Promise<TonAccountState> {
    return super.getAccountState(address);
  }

  realTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    return super.getTransactions(address, page);
  }

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await super.getAccountState(address);
    return this.frozen === null ? real : { ...this.frozen.state, chainTime: real.chainTime };
  }

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    if (this.emptyListings > 0 && page.at !== undefined) {
      this.emptyListings -= 1;
      return [];
    }
    if (this.frozen === null) return super.getTransactions(address, page);
    return listing(this.frozen.txs, page, this.unknownCursor);
  }
}

/** A second source on the same chain that may serve a snapshot of its own. */
export class LaggingWitness implements TonChainWitness {
  frozen: Snapshot | null = null;
  unknownCursor: 'BELOW' | 'ERROR' = 'BELOW';

  constructor(private readonly node: LaggingNode) {}

  async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await this.node.realState(address);
    return this.frozen === null ? real : { ...this.frozen.state, chainTime: real.chainTime };
  }

  async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    if (this.frozen === null) return this.node.realTransactions(address, page);
    return listing(this.frozen.txs, page, this.unknownCursor);
  }
}

/** One BROADCAST payout (seqno 0, validUntil T0 + 60) and a reader watching it. */
export function trustSetup(witnessed = false) {
  const node = new LaggingNode({ production: false, dryRun: true });
  const wallet = dryRunTonWallet('testnet');
  node.registerWallet(wallet, 100n * TON);
  const witness = new LaggingWitness(node);
  const payee = new Address(0, randomBytes(32));
  const signed = wallet.sign({
    seqno: 0,
    validUntilSec: T0 + 60,
    to: payee,
    amountNano: TON,
    body: beginCell().storeUint(0, 32).storeStringTail('order').endCell(),
    bounce: true,
    deploy: false,
  });
  const transfer: StoredTransfer = {
    id: 'cm0trust2',
    purpose: 'ORDER',
    attemptId: 'a1',
    network: 'testnet',
    walletAddress: wallet.rawAddress,
    seqno: 0,
    validUntil: new Date((T0 + 60) * 1_000),
    toAddress: rawAddress(payee),
    amountNanoTon: TON,
    payloadHash: signed.payloadHash,
    extMsgHash: signed.extMsgHash,
    status: 'BROADCAST',
    txHash: null,
    createdAt: new Date((T0 - 2_000) * 1_000),
  };
  const reader = new TonChainReader(node, wallet, TRUST_TIMING, witnessed ? [witness] : []);
  const snapshot = async (): Promise<Snapshot> => ({
    state: await node.realState(wallet.address),
    txs: node.transactionsOf(wallet.address),
  });
  /** One look with the chain (and the database clock) at `at`. */
  const lookAt = async (at: number): Promise<string> => {
    node.setChainTime(at);
    const v: TonVerdict = await reader.examine(transfer, () => Promise.resolve(at * 1_000));
    return v.kind === 'WAIT' ? `WAIT:${v.detail}` : v.kind;
  };
  /** `times` looks from `from` on, 40 s apart. */
  const looksFrom = async (from: number, times: number): Promise<string[]> => {
    const seen: string[] = [];
    for (let i = 0; i < times; i += 1) seen.push(await lookAt(from + i * 40));
    return seen;
  };
  const send = () => node.sendBoc(signed.boc);
  const progress = () => reader.scanProgressOf(transfer.id);
  return { node, wallet, witness, transfer, reader, snapshot, lookAt, looksFrom, send, progress };
}
