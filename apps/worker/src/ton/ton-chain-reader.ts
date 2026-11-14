import { Inject, Injectable } from '@nestjs/common';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import type { Address, Transaction } from '@ton/core';
import { parseTonAddress } from './ton-address';
import {
  classifyDestination,
  classifyNotFound,
  classifyOurTx,
  type DestinationView,
  type TonVerdict,
  type TransferFacts,
} from './ton-classifier';
import { freshObservation } from './ton-fresh-look';
import {
  TonGatewayError,
  type TonAccountState,
  type TonChainWitness,
  type TonGateway,
} from './ton-gateway';
import {
  TON_EXPIRY_WITNESSES,
  TON_GATEWAY,
  TON_TIMING,
  TON_WALLET,
  scanSlackSec,
  type TonTiming,
} from './ton-tokens';
import type { StoredTransfer } from './ton-transfer.repository';
import {
  abortedWithoutBounce,
  bounceSentBack,
  processedOurMessage,
  returnTxOf,
  type OutMessageFacts,
} from './ton-tx-facts';
import { NO_PROGRESS, advanceScan, type ScanProgress, type ScanStep } from './ton-tx-scan';
import { seqnoOf, type W5Data } from './ton-w5';
import type { TonWallet } from './ton-wallet';

// One look at the chain for one stored transfer (plan 6.4 step 6, 6.5). The scan of the wallet's
// transactions goes on across looks (ton-tx-scan.ts: bounded by time, a few pages per look), and
// its progress, our transaction once found and the start of the destination's grace are kept per
// transfer in memory (a restart only reads again). The pure classifier decides; an EXPIRY
// observation needs the database clock past validUntil + the margin too, the same state seen over
// a new connection (audit M-1 (b), ton-fresh-look.ts) and the agreement of every expiry witness
// (D-60 (2)); a witness that sees our message or a moved seqno is a WITNESS_CONFLICT (review m3),
// and stays one for that transfer in this process (review RR2-4; the write layer bars EXPIRED after
// it for good, a restart included). Nothing is written here. A gateway failure is a WAIT.

/** Transfers watched at once: one unresolved per wallet, so a few; old ones are dropped first. */
const MAX_WATCHES = 256;
const MARGIN_SEC = Math.ceil(TON_NOT_SENT_MARGIN_MS / 1_000);

export function transferFacts(transfer: StoredTransfer): TransferFacts {
  return {
    seqno: transfer.seqno,
    validUntilSec: Math.floor(transfer.validUntil.getTime() / 1_000),
    toAddress: transfer.toAddress,
    amountNano: transfer.amountNanoTon,
    payloadHash: transfer.payloadHash,
  };
}

interface Watch {
  progress: ScanProgress;
  /** Our transaction once found: a transaction never changes, so it is not searched again. */
  found: Transaction | null;
  /**
   * The destination's transaction that processed our message, once seen: a node that later
   * answers "not found" (it lags) cannot turn a seen bounce into "not visible", hence delivered.
   */
  destTx: Transaction | null;
  /** The chain time of the first successful "not found" answer of the destination lookup. */
  notFoundSince: number | null;
  /** A witness once contradicted "not sent": no later look offers an EXPIRY again (RR2-4). */
  conflict: WitnessConflict | null;
}

type WitnessConflict = Extract<TonVerdict, { readonly kind: 'WITNESS_CONFLICT' }>;

@Injectable()
export class TonChainReader {
  private readonly watches = new Map<string, Watch>();
  /** Only the wallet's public data is kept, never the signer (audit I-1). */
  readonly #own: W5Data;

  constructor(
    @Inject(TON_GATEWAY) private readonly gateway: TonGateway,
    @Inject(TON_WALLET) wallet: Pick<TonWallet, 'own'>,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
    @Inject(TON_EXPIRY_WITNESSES) private readonly witnesses: readonly TonChainWitness[],
  ) {
    this.#own = wallet.own;
  }

  async examine(
    transfer: StoredTransfer,
    databaseNowMs: () => Promise<number>,
  ): Promise<TonVerdict> {
    try {
      return await this.examineChain(transfer, databaseNowMs);
    } catch (error) {
      if (error instanceof TonGatewayError) return { kind: 'WAIT', detail: 'GATEWAY' };
      throw error;
    }
  }

  /** The transfer is decided: what was kept for it is dropped. */
  forget(transferId: string): void {
    for (let source = 0; source <= this.witnesses.length; source += 1) {
      this.watches.delete(`${String(source)}:${transferId}`);
    }
  }

  private async examineChain(
    transfer: StoredTransfer,
    databaseNowMs: () => Promise<number>,
  ): Promise<TonVerdict> {
    const address = parseTonAddress(transfer.walletAddress, 'TonTransfer.walletAddress');
    const facts = transferFacts(transfer);
    const watch = this.watchOf(0, transfer.id);
    // Read every look: a new pass is anchored at it, and the destination's grace runs on it.
    const state = await this.gateway.getAccountState(address);
    if (watch.found === null) {
      const step = await this.scan(this.gateway, watch, transfer, address, state, databaseNowMs);
      if (step.kind !== 'FOUND') return this.notFound(transfer, address, step, databaseNowMs);
      watch.found = step.tx;
    }
    const paid = classifyOurTx(facts, watch.found);
    if (paid.kind === 'SUSPECT') return paid;
    const view = await this.destinationView(watch, address, paid.out, state.chainTime);
    return classifyDestination(paid, view, state.chainTime, this.timing.destGraceSec);
  }

  private async scan(
    gateway: TonChainWitness,
    watch: Watch,
    transfer: StoredTransfer,
    address: Address,
    state: TonAccountState,
    databaseNowMs: () => Promise<number>,
  ): Promise<ScanStep> {
    const facts = transferFacts(transfer);
    const step = await advanceScan(
      {
        fetchPage: (page) => gateway.getTransactions(address, page),
        address,
        extMsgHash: transfer.extMsgHash,
        // The signing transaction bounds createdAt - (chain time at signing): see signLagMaxSec.
        sinceUtime: Math.floor(transfer.createdAt.getTime() / 1_000) - scanSlackSec(this.timing),
      },
      watch.progress,
      async () => {
        // The database clock is read right after the state only when it may prove an expiry.
        const candidate =
          seqnoOf(state, this.#own) === facts.seqno &&
          state.chainTime > facts.validUntilSec + MARGIN_SEC;
        return { state, atMs: candidate ? await databaseNowMs() : null };
      },
    );
    if (step.kind !== 'FOUND') watch.progress = step.progress;
    return step;
  }

  private async notFound(
    transfer: StoredTransfer,
    address: Address,
    step: Exclude<ScanStep, { readonly kind: 'FOUND' }>,
    databaseNowMs: () => Promise<number>,
  ): Promise<TonVerdict> {
    if (step.kind === 'STALE') return { kind: 'WAIT', detail: 'INDEX_STALE' };
    if (step.kind === 'PARTIAL') {
      return { kind: 'WAIT', detail: step.cause === 'GATEWAY' ? 'GATEWAY' : 'INDEX_SCANNING' };
    }
    const facts = transferFacts(transfer);
    const anchor = step.anchor.state;
    const seqno = seqnoOf(anchor, this.#own);
    const verdict = classifyNotFound(facts, seqno, anchor.chainTime);
    if (verdict.kind !== 'EXPIRY_CANDIDATE') return verdict;
    const watch = this.watchOf(0, transfer.id);
    if (watch.conflict !== null) return watch.conflict;
    const atMs = step.anchor.atMs;
    // The guard of migration 10 refuses EXPIRED before validUntil + the margin by the DB clock.
    if (atMs === null || atMs < transfer.validUntil.getTime() + TON_NOT_SENT_MARGIN_MS) {
      return { kind: 'WAIT', detail: 'DB_CLOCK_BEHIND' };
    }
    const observation = await freshObservation({
      connection: this.gateway.freshConnection(),
      own: this.#own,
      transfer,
      facts,
      address,
      anchor,
      databaseNowMs,
    });
    if (observation === null) return { kind: 'WAIT', detail: 'FRESH_DISAGREES' };
    const witnessed = await this.witnessVerdict(transfer, address);
    if (witnessed?.kind === 'WITNESS_CONFLICT') watch.conflict = witnessed;
    return witnessed ?? { kind: 'EXPIRY_SEEN', observation };
  }

  /**
   * Null when every second source sees the same (a COMPLETE scan, seqno unchanged, chain time
   * past); a WAIT while one cannot tell yet; WITNESS_CONFLICT when one sees our message or a moved
   * seqno (review m3): the primary source's "not found" is then contradicted, never EXPIRED.
   */
  private async witnessVerdict(
    transfer: StoredTransfer,
    address: Address,
  ): Promise<TonVerdict | null> {
    const facts = transferFacts(transfer);
    for (const [witness, source] of this.witnesses.entries()) {
      const watch = this.watchOf(witness + 1, transfer.id);
      const state = await source.getAccountState(address);
      const step = await this.scan(source, watch, transfer, address, state, () =>
        Promise.resolve(0),
      );
      if (step.kind === 'FOUND') return { kind: 'WITNESS_CONFLICT', detail: 'FOUND', witness };
      if (step.kind !== 'COMPLETE') return { kind: 'WAIT', detail: 'WITNESS_PENDING' };
      const anchor = step.anchor.state;
      const seen = classifyNotFound(facts, seqnoOf(anchor, this.#own), anchor.chainTime);
      if (seen.kind === 'CONSUMED_UNMATCHED') {
        return { kind: 'WITNESS_CONFLICT', detail: 'SEQNO_MOVED', witness };
      }
      if (seen.kind !== 'EXPIRY_CANDIDATE') return { kind: 'WAIT', detail: 'WITNESS_PENDING' };
    }
    return null;
  }

  /**
   * What the destination did with OUR out message: its transaction found by (source, createdLt),
   * then, for a bounce, OUR transaction that received the value back (found the same way).
   */
  private async destinationView(
    watch: Watch,
    wallet: Address,
    out: OutMessageFacts,
    chainTime: number,
  ): Promise<DestinationView> {
    const destination = parseTonAddress(out.dest, 'the destination');
    const destTx =
      watch.destTx ?? (await this.gateway.findResultTx(wallet, destination, out.createdLt));
    if (destTx === null) {
      watch.notFoundSince ??= chainTime;
      return { kind: 'NOT_VISIBLE', since: watch.notFoundSince };
    }
    // An index answering with another transaction proves nothing: the grace starts over.
    if (!processedOurMessage(destTx, wallet, out)) {
      watch.notFoundSince = null;
      return { kind: 'MISMATCH' };
    }
    watch.destTx = destTx;
    const bounce = bounceSentBack(destTx, wallet);
    if (bounce !== null) {
      const back = await this.gateway.findResultTx(destination, wallet, bounce.createdLt);
      return {
        kind: 'BOUNCED',
        bounce,
        returnTx: back === null ? null : returnTxOf(back, wallet, out.dest, bounce),
      };
    }
    return abortedWithoutBounce(destTx, wallet) ? { kind: 'ABORTED' } : { kind: 'PROCESSED' };
  }

  /** The watch of one source (0 = the gateway, 1.. = the witnesses), most recent last. */
  private watchOf(source: number, transferId: string): Watch {
    const key = `${String(source)}:${transferId}`;
    const watch = this.watches.get(key) ?? {
      progress: NO_PROGRESS,
      found: null,
      destTx: null,
      notFoundSince: null,
      conflict: null,
    };
    this.watches.delete(key);
    this.watches.set(key, watch);
    for (const old of this.watches.keys()) {
      if (this.watches.size <= MAX_WATCHES) break;
      this.watches.delete(old);
    }
    return watch;
  }
}
