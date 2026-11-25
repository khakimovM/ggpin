import type { TonAccountState } from './ton-gateway';
import {
  NO_PROGRESS,
  sameRef,
  type ScanAnchor,
  type ScanProgress,
  type ScanStep,
  type StaleCause,
} from './ton-tx-scan';

// Phase 5 S9 audit L-1 (third fix round: review M2, audit H-1, Variant A). A scan cursor kept in
// the database (ton-scan-cursor.ts) that the chain keeps contradicting (forged or corrupted: a
// `covered` transaction above every real one, a pass whose `next` does not exist) would end every
// look STALE or failed, keep the transfer BROADCAST and, through the one-unresolved-transfer-per-
// wallet index, block the whole hot wallet even across restarts. Such a cursor is ADVISORY until
// a pass of this process completes (or follows the chain for a whole page budget), and only an
// advisory cursor is ever dropped: dropping it equals a restart without a cursor (S5), always
// safe, at the cost of a scan from the head.
//
// This process's own progress and every witness's progress are never touched: they behave
// exactly as in S5 (05bff3b). Both their `covered` AND the anchor of their pass in flight are
// floors this process checked itself (passOf, headIs): dropping either lets a node frozen below
// our landed payout complete a pass and offer an EXPIRY observation (review M1, M2; audit H-1).
//
// | look                             | advisory (from the database)       | own progress, witnesses |
// | covered above the fresh state    | everything dropped, at once        | nothing                 |
// | STALE FLOOR or PASS              | 3 in a row: everything dropped     | nothing                 |
// | PARTIAL GATEWAY at the same pass | 3 in a row: everything dropped     | nothing (not counted)   |
// | STALE RACE (state/index race)    | not counted                        | not counted             |
// | STALE FORK                       | the scan dropped everything itself | the same                |
// | COMPLETE or BUDGET               | counts cleared, own progress now   | counts stay 0           |
//
// The price, accepted on purpose: own progress the chain keeps contradicting (a provider serving
// stale or false data to this process, a pass whose `next` vanished) blocks the wallet, fail
// closed, until the node recovers or the worker restarts (the cursor is then advisory again); the
// owner hears `tonWalletBlocked`. The counts live in memory, not in the cursor: a count in the
// database would be one more field a forged cursor could carry.

/**
 * Looks in a row that contradict an advisory cursor (STALE FLOOR or PASS; a failed listing at the
 * same pass, the account state read fine) before it is dropped. Dropping an advisory cursor only
 * costs a scan from the head, so the limit is small: a rate-limit burst or a 5xx spell rarely
 * spans 3 looks at one cursor, and a wrong drop costs pages, never money (audit L-a). After a
 * restart the order reconciler may be the only one looking (one look a tick,
 * ORDER_RECONCILE_EVERY_MS 10 min by default): the wallet stays blocked about 30 minutes, not 100.
 */
export const ADVISORY_LOOKS_BEFORE_RESCAN = 3;

/** The part of a watch the trust rules read and change. */
export interface ScanTrust {
  progress: ScanProgress;
  /** STALE looks (FLOOR or PASS) of an advisory cursor; 0 for any other watch. */
  staleLooks: number;
  /** Failed listings in a row at the same pass of an advisory cursor; 0 for any other watch. */
  gatewayLooks: number;
  /** The progress came from the database and no pass of this process has completed since. */
  advisory: boolean;
}

/** An advisory cursor is forgotten: the next look scans as a fresh worker would (S5). */
function forget(watch: ScanTrust): void {
  watch.progress = NO_PROGRESS;
  watch.staleLooks = 0;
  watch.gatewayLooks = 0;
  watch.advisory = false;
}

function sameAnchor(a: ScanAnchor, b: ScanAnchor): boolean {
  const x = a.state.lastTx;
  const y = b.state.lastTx;
  return a.atMs === b.atMs && (x === null ? y === null : y !== null && sameRef(x, y));
}

/** The look ended where it began: the same pass, at the same next transaction. */
function samePass(before: ScanProgress['pass'], after: ScanProgress['pass']): boolean {
  if (before === null || after === null) return false;
  return sameRef(before.next, after.next) && sameAnchor(before.anchor, after.anchor);
}

/** Before a look: an advisory cursor that claims more than the fresh state knows is dropped. */
export function trustBeforeLook(watch: ScanTrust, state: TonAccountState): void {
  const covered = watch.progress.covered;
  if (!watch.advisory || covered === null) return;
  const last = state.lastTx;
  if (last === null || last.lt < covered.lt) forget(watch);
}

function advisoryStale(watch: ScanTrust, cause: StaleCause): void {
  if (cause === 'RACE') return;
  // FORK: the scan has already dropped the progress; nothing advisory is left.
  if (cause !== 'FORK') watch.staleLooks += 1;
  if (cause === 'FORK' || watch.staleLooks >= ADVISORY_LOOKS_BEFORE_RESCAN) forget(watch);
}

/** After a look that did not find our transaction: keeps its progress (S5), or drops a cursor. */
export function trustAfterLook(
  watch: ScanTrust,
  step: Exclude<ScanStep, { readonly kind: 'FOUND' }>,
): void {
  const before = watch.progress.pass;
  watch.progress = step.progress;
  if (step.kind === 'COMPLETE' || step.cause === 'BUDGET') {
    // This process read the chain itself: the progress is its own from now on.
    watch.staleLooks = 0;
    watch.gatewayLooks = 0;
    watch.advisory = false;
    return;
  }
  // S5 (05bff3b) for this process's own progress and the witnesses': nothing else happens.
  if (!watch.advisory) return;
  if (step.kind === 'STALE') {
    advisoryStale(watch, step.cause);
    return;
  }
  if (!samePass(before, step.progress.pass)) {
    watch.gatewayLooks = 0;
    return;
  }
  watch.gatewayLooks += 1;
  if (watch.gatewayLooks >= ADVISORY_LOOKS_BEFORE_RESCAN) forget(watch);
}
