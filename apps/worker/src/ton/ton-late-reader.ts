import { Inject, Injectable } from '@nestjs/common';
import type { Address, Transaction } from '@ton/core';
import { hashHex, parseTonAddress } from './ton-address';
import type { DestinationView } from './ton-classifier';
import type { TonChainWitness, TonGateway, TonTxRef } from './ton-gateway';
import type { LateTransfer } from './ton-late.repository';
import {
  TON_EXPIRY_WITNESSES,
  TON_GATEWAY,
  TON_TIMING,
  scanSlackSec,
  type TonTiming,
} from './ton-tokens';
import {
  abortedWithoutBounce,
  bounceSentBack,
  processedOurMessage,
  returnTxOf,
  type OutMessageFacts,
} from './ton-tx-facts';
import { advanceScan, sameRef, txRef } from './ton-tx-scan';
import { TonWatches } from './ton-watches';

// The chain reads of the late facts (phase 5 S9f), apart from TonChainReader (whose watches and
// scan trust belong to the unresolved payouts, Variant A): reads only, nothing is written here.
// - findOurs: the late look for an EXPIRED / CONSUMED_UNMATCHED transfer's own message. The scan is
//   S5's (ton-tx-scan.ts, bounded by time, a few pages per look) on progress kept in THIS process
//   only: it starts from nothing after a restart (no cursor is loaded from the database, so there
//   is nothing to trust or drop); once found, the transaction is kept and never searched again.
//   A look that ends STALE or PARTIAL says so (the step counts `wait:SCAN_STALE`, audit L-5);
// - atEverySource: the transaction listed AT one (lt, hash), by the primary source and by every
//   expiry witness (the Z6 hint, ONCHAIN_FAILED);
// - destination: what the destination did with our out message: S5's lookup (its transaction found
//   by (source, createdLt), then, for a bounce, our wallet's return transaction), with the first
//   "not found" time and a seen destination transaction kept per key.
// The scan and the destination looks keep their watches in two separate LRUs (review F7, audit
// L-4): a burst of late scans can never push out what a destination look (a hint's) has seen.
// A TonGatewayError goes to the caller: it is a WAIT, never "not there".

/** The one source both LRUs use: each LRU holds one kind of watch. */
const PRIMARY = 0;

export interface SourcesAt {
  readonly primary: Transaction | null;
  readonly witnesses: readonly (Transaction | null)[];
}

export interface DestinationLook {
  readonly view: DestinationView;
  /** The primary source's chain time at this look (the grace of a NOT_VISIBLE runs on it). */
  readonly chainTime: number;
  /** The destination's transaction that took our message, when one was seen. */
  readonly destTxHash: string | null;
}

/** Where a late scan stands: our transaction, a finished pass without it, or a look that failed. */
export type OursLook =
  | { readonly kind: 'FOUND'; readonly tx: Transaction }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'PARTIAL' };

/** The first transaction a source lists AT `ref` when it is that very transaction, else null. */
async function firstAt(
  source: TonChainWitness,
  address: Address,
  ref: TonTxRef,
): Promise<Transaction | null> {
  const [first] = await source.getTransactions(address, { limit: 1, at: ref });
  return first !== undefined && sameRef(txRef(first), ref) ? first : null;
}

@Injectable()
export class TonLateReader {
  private readonly scans = new TonWatches();
  private readonly destinations = new TonWatches();

  constructor(
    @Inject(TON_GATEWAY) private readonly gateway: TonGateway,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
    @Inject(TON_EXPIRY_WITNESSES) private readonly witnesses: readonly TonChainWitness[],
  ) {}

  /** How many expiry witnesses there are (0 until S12 in production). */
  get witnessCount(): number {
    return this.witnesses.length;
  }

  /** Our message's transaction, or where the scan for it stands. */
  async findOurs(transfer: LateTransfer): Promise<OursLook> {
    const watch = this.scans.of(PRIMARY, transfer.id);
    if (watch.found !== null) return { kind: 'FOUND', tx: watch.found };
    const address = parseTonAddress(transfer.walletAddress, 'TonTransfer.walletAddress');
    const state = await this.gateway.getAccountState(address);
    const step = await advanceScan(
      {
        fetchPage: (page) => this.gateway.getTransactions(address, page),
        address,
        extMsgHash: transfer.extMsgHash,
        sinceUtime: Math.floor(transfer.createdAt.getTime() / 1_000) - scanSlackSec(this.timing),
      },
      watch.progress,
      () => Promise.resolve({ state, atMs: null }),
    );
    if (step.kind === 'FOUND') {
      watch.found = step.tx;
      return { kind: 'FOUND', tx: step.tx };
    }
    // S5: the look's progress is kept as it is (COMPLETE, PARTIAL and STALE alike).
    watch.progress = step.progress;
    return { kind: step.kind === 'COMPLETE' ? 'NOT_FOUND' : step.kind };
  }

  async primaryAt(address: Address, ref: TonTxRef): Promise<Transaction | null> {
    return firstAt(this.gateway, address, ref);
  }

  async atEverySource(address: Address, ref: TonTxRef): Promise<SourcesAt> {
    const primary = await firstAt(this.gateway, address, ref);
    const witnesses: (Transaction | null)[] = [];
    for (const source of this.witnesses) witnesses.push(await firstAt(source, address, ref));
    return { primary, witnesses };
  }

  /** `key` names the out message (the transfer, or the transfer and the hint it came from). */
  async destination(key: string, wallet: Address, out: OutMessageFacts): Promise<DestinationLook> {
    const watch = this.destinations.of(PRIMARY, key);
    const { chainTime } = await this.gateway.getAccountState(wallet);
    const destination = parseTonAddress(out.dest, 'the destination');
    const destTx =
      watch.destTx ?? (await this.gateway.findResultTx(wallet, destination, out.createdLt));
    if (destTx === null) {
      watch.notFoundSince ??= chainTime;
      const since = watch.notFoundSince;
      return { view: { kind: 'NOT_VISIBLE', since }, chainTime, destTxHash: null };
    }
    // An index answering with another transaction proves nothing: the grace starts over.
    if (!processedOurMessage(destTx, wallet, out)) {
      watch.notFoundSince = null;
      return { view: { kind: 'MISMATCH' }, chainTime, destTxHash: null };
    }
    watch.destTx = destTx;
    const destTxHash = hashHex(destTx.hash());
    const bounce = bounceSentBack(destTx, wallet);
    if (bounce !== null) {
      const back = await this.gateway.findResultTx(destination, wallet, bounce.createdLt);
      const returnTx = back === null ? null : returnTxOf(back, wallet, out.dest, bounce);
      return { view: { kind: 'BOUNCED', bounce, returnTx }, chainTime, destTxHash };
    }
    const view: DestinationView = abortedWithoutBounce(destTx, wallet)
      ? { kind: 'ABORTED' }
      : { kind: 'PROCESSED' };
    return { view, chainTime, destTxHash };
  }

  /** The transfer is settled for the late looks: what was kept for it is dropped. */
  forget(key: string): void {
    this.destinations.forget(key, PRIMARY);
  }
}
