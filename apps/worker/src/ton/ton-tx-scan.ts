import { beginCell, storeMessage, type Address, type Message, type Transaction } from '@ton/core';
import { hashHex } from './ton-address';
import { TonGatewayError, type TonAccountState, type TonTxRef, type TxPage } from './ton-gateway';

// Finding our signed message among the wallet's transactions (plan 6.4 step 6). The key is the
// NORMALIZED hash of the external message (TEP-467, docs.ton.org "Message lookup"): the source is
// set to addr_none, the import fee to 0, the StateInit dropped and the body always stored in a
// reference, so the same message hashes the same however a node re-serialized it. The plan's
// assumption that this lookup finds our message on the real chain is confirmed only by the S12
// testnet self-test (plan 6.5).
//
// The scan is bounded by TIME, not by a page count (audit H1: 128 inbound dust transfers used to
// push our transaction out of a fixed 8-page window for good). A pass is anchored at one account
// state and walks the account's own chain of transactions (each names its predecessor) from that
// state's last transaction down to the window start (the transfer's creation minus a clock
// reserve) or to the last transaction an earlier pass already covered. A look reads at most
// SCAN_PAGES_PER_LOOK pages and the pass goes on from its cursor at the next look, so the cost is
// proportional to the number of transactions, each of which the spammer pays for. Only a
// COMPLETE pass may lead to "not found"; anything less is a WAIT.
//
// Audit M-1 (a): a pass rests on an account state only when the index of the same source names
// that state's last transaction as the account's NEWEST one. A node serving an old state (old
// seqno, old last transaction) with a current chain time is caught even while its index is
// current. That head listing is the first page of the pass, so it costs no request except on a
// look with nothing new since what was covered: one listing of one transaction there. Progress
// survives a bad answer (review m1, audit L-2): a page that fails ends the look PARTIAL with the
// cursor kept, and a STALE answer keeps what earlier passes covered (and the cursor of a pass in
// flight); only a chain that contradicts the covered transaction itself drops it.

export function normalizedExternalHash(message: Message): string {
  if (message.info.type !== 'external-in') {
    throw new Error('only an inbound external message has a normalized hash');
  }
  const normalized: Message = {
    info: { type: 'external-in', src: null, dest: message.info.dest, importFee: 0n },
    init: null,
    body: message.body,
  };
  return hashHex(
    beginCell()
      .store(storeMessage(normalized, { forceRef: true }))
      .endCell()
      .hash(),
  );
}

export function txRef(tx: Transaction): TonTxRef {
  return { lt: tx.lt, hash: hashHex(tx.hash()) };
}

export function sameRef(a: TonTxRef, b: TonTxRef): boolean {
  return a.lt === b.lt && a.hash === b.hash;
}

/** The account's transaction before this one, or null for its first transaction. */
export function prevRef(tx: Transaction): TonTxRef | null {
  if (tx.prevTransactionLt === 0n) return null;
  return { lt: tx.prevTransactionLt, hash: tx.prevTransactionHash.toString(16).padStart(64, '0') };
}

/** The transaction belongs to `address` and was started by the external message `extMsgHash`. */
export function isOwnExternal(tx: Transaction, address: Address, extMsgHash: string): boolean {
  const message = tx.inMessage;
  if (message?.info.type !== 'external-in') return false;
  // A confused index must not hand us another account's transaction (plan §11: index lies).
  if (tx.address !== BigInt(`0x${address.hash.toString('hex')}`)) return false;
  if (!message.info.dest.equals(address)) return false;
  return normalizedExternalHash(message) === extMsgHash;
}

/**
 * toncenter's documented maximum for getTransactions (ton-http-api: `limit` gt=0, le=100). The
 * scan asks inclusively, so HttpApi does not add one: a page is exactly this. Audit L-2.
 */
export const SCAN_PAGE_SIZE = 100;
/** Pages one look may read; an unfinished pass continues from its cursor at the next look. */
export const SCAN_PAGES_PER_LOOK = 8;

export interface ScanAnchor {
  /** The account state the pass rests on: its last transaction is where the pass starts. */
  readonly state: TonAccountState;
  /** The database clock (epoch ms) right after that state was read; null when not needed. */
  readonly atMs: number | null;
}

export interface ScanProgress {
  /** Every transaction from the window start up to this one was read: later passes stop here. */
  readonly covered: TonTxRef | null;
  /** The pass in flight: its anchor and the next transaction the listing must return. */
  readonly pass: { readonly anchor: ScanAnchor; readonly next: TonTxRef } | null;
}

export const NO_PROGRESS: ScanProgress = Object.freeze({ covered: null, pass: null });

export type ScanStep =
  | { readonly kind: 'FOUND'; readonly tx: Transaction }
  /** Read in full up to the anchor's last transaction: our message is not among them. */
  | { readonly kind: 'COMPLETE'; readonly anchor: ScanAnchor; readonly progress: ScanProgress }
  /**
   * The page budget of this look ran out (BUDGET) or a listing failed (GATEWAY): the next look goes
   * on from `progress`, nothing read is lost.
   */
  | {
      readonly kind: 'PARTIAL';
      readonly progress: ScanProgress;
      readonly cause: 'BUDGET' | 'GATEWAY';
    }
  /** The listing contradicts the state or itself (a lagging or lying index): ask again. */
  | { readonly kind: 'STALE'; readonly progress: ScanProgress };

export interface ScanRequest {
  readonly fetchPage: (page: TxPage) => Promise<readonly Transaction[]>;
  readonly address: Address;
  readonly extMsgHash: string;
  /** Older transactions cannot hold our message (it did not exist yet): a pass stops there. */
  readonly sinceUtime: number;
  readonly pagesPerLook?: number;
}

function complete(anchor: ScanAnchor): ScanStep {
  return { kind: 'COMPLETE', anchor, progress: { covered: anchor.state.lastTx, pass: null } };
}

/** A listing, or null when the source failed to answer (the look ends PARTIAL, nothing lost). */
async function listing(request: ScanRequest, page: TxPage): Promise<readonly Transaction[] | null> {
  try {
    return await request.fetchPage(page);
  } catch (error) {
    if (error instanceof TonGatewayError) return null;
    throw error;
  }
}

/** The index names `last` as the account's newest transaction (none at all for null). */
export function headIs(head: readonly Transaction[], last: TonTxRef | null): boolean {
  const newest = head[0];
  if (last === null) return newest === undefined;
  return newest !== undefined && sameRef(txRef(newest), last);
}

interface Pass {
  readonly anchor: ScanAnchor;
  readonly next: TonTxRef;
  /** The head listing of a new pass: its first page, already read. */
  readonly head: readonly Transaction[] | null;
}

/** The pass to continue, a new one anchored at a fresh state, or the step it ends in at once. */
async function passOf(
  request: ScanRequest,
  progress: ScanProgress,
  newAnchor: () => Promise<ScanAnchor>,
): Promise<Pass | ScanStep> {
  if (progress.pass !== null) return { ...progress.pass, head: null };
  const covered = progress.covered;
  const kept: ScanProgress = { covered, pass: null };
  const anchor = await newAnchor();
  const last = anchor.state.lastTx;
  // A state older than what an earlier pass covered is a stale state.
  if (covered !== null && (last === null || last.lt < covered.lt)) {
    return { kind: 'STALE', progress: kept };
  }
  const settled = last === null || (covered !== null && sameRef(last, covered));
  const head = await listing(request, { limit: settled ? 1 : SCAN_PAGE_SIZE });
  if (head === null) return { kind: 'PARTIAL', progress: kept, cause: 'GATEWAY' };
  // M-1 (a): the index knows a transaction the state does not (or lags it): no pass rests on it.
  if (!headIs(head, last)) return { kind: 'STALE', progress: kept };
  if (last === null || settled) return complete(anchor);
  return { anchor, next: last, head };
}

/**
 * One look's share of the scan. `newAnchor` is called only when a new pass starts. FOUND as soon
 * as our message shows up; COMPLETE only when the pass reached the window start, the account's
 * first transaction or what an earlier pass covered, with every transaction on the way being
 * exactly the predecessor of the one before it.
 */
export async function advanceScan(
  request: ScanRequest,
  progress: ScanProgress,
  newAnchor: () => Promise<ScanAnchor>,
): Promise<ScanStep> {
  const pass = await passOf(request, progress, newAnchor);
  if ('kind' in pass) return pass;
  const covered = progress.covered;
  let next = pass.next;
  let prefetched = pass.head;
  // Every transaction above `next` was read and is a hash-linked part of the anchor's chain.
  const here = (): ScanProgress => ({ covered, pass: { anchor: pass.anchor, next } });
  const pages = request.pagesPerLook ?? SCAN_PAGES_PER_LOOK;
  for (let page = 0; page < pages; page += 1) {
    const txs = prefetched ?? (await listing(request, { limit: SCAN_PAGE_SIZE, at: next }));
    prefetched = null;
    if (txs === null) return { kind: 'PARTIAL', progress: here(), cause: 'GATEWAY' };
    // An empty page is a bad answer, not a fact: the same cursor is asked again next time.
    if (txs.length === 0) return { kind: 'STALE', progress: here() };
    for (const tx of txs) {
      // The listing must follow the account's chain exactly: a skipped or foreign transaction
      // would make "not found" a lie.
      if (!sameRef(txRef(tx), next)) return { kind: 'STALE', progress: here() };
      if (isOwnExternal(tx, request.address, request.extMsgHash)) return { kind: 'FOUND', tx };
      const prev = prevRef(tx);
      if (tx.now < request.sinceUtime || prev === null) return complete(pass.anchor);
      if (covered !== null && sameRef(prev, covered)) return complete(pass.anchor);
      // The anchor's verified chain skips the covered transaction: that one was the lie.
      if (covered !== null && prev.lt < covered.lt) return { kind: 'STALE', progress: NO_PROGRESS };
      next = prev;
    }
  }
  return { kind: 'PARTIAL', progress: here(), cause: 'BUDGET' };
}
