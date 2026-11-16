import type { Transaction } from '@ton/core';
import type { TonVerdict } from './ton-classifier';
import { NO_PROGRESS, type ScanProgress } from './ton-tx-scan';

// What TonChainReader keeps per transfer and chain source between looks (in memory; the primary
// source's scan progress is also kept in the database by TonConfirmService, phase 5 S9 L-2).
// Source 0 is the gateway, 1.. the expiry witnesses. The least recently used watch goes first.

/** Transfers watched at once: one unresolved per wallet, so a few; old ones are dropped first. */
const MAX_WATCHES = 256;

export type WitnessConflict = Extract<TonVerdict, { readonly kind: 'WITNESS_CONFLICT' }>;

export interface Watch {
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

function keyOf(source: number, transferId: string): string {
  return `${String(source)}:${transferId}`;
}

export class TonWatches {
  private readonly watches = new Map<string, Watch>();

  /** The watch of one source, created when missing; it becomes the most recently used. */
  of(source: number, transferId: string, start: ScanProgress = NO_PROGRESS): Watch {
    const key = keyOf(source, transferId);
    const watch = this.watches.get(key) ?? {
      progress: start,
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

  /** The watch when one is kept, without creating or touching it. */
  peek(source: number, transferId: string): Watch | null {
    return this.watches.get(keyOf(source, transferId)) ?? null;
  }

  /** Drops the watches of every source (0..sources) of the transfer. */
  forget(transferId: string, sources: number): void {
    for (let source = 0; source <= sources; source += 1) {
      this.watches.delete(keyOf(source, transferId));
    }
  }
}
