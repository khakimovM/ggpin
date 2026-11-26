import { classifyDestination, type DestinationView, type PaidStep } from './ton-classifier';
import type { HintRejectCode } from './ton-tx-hint.verifier';

// Pure parts of the Z6 hint check (phase 5 S9f) that TonLateService applies after the verifier:
// - the destination of a matching hint (review F7, audit L-4): ONLY a destination transaction that
//   processed our message accepts the hint; "not visible yet" never turns into CONFIRMED after a
//   grace (the late looks keep no reliable "since" across an LRU drop or a restart), it waits;
// - a source that has not listed the hinted transaction (yet) is not a final answer (review F2,
//   audit L-3): TX_NOT_FOUND and WITNESS_MISMATCH wait HINT_TRANSIENT_LOOKS looks of the same hint
//   before they are kept as the verdict. NO_WITNESS never becomes a verdict (the caller waits
//   without reading the chain): once a witness exists, the same hint must still be able to pass.

/** Looks of one hint (one reconciler tick each) before a "not listed" answer is the verdict. */
export const HINT_TRANSIENT_LOOKS = 10;

const TRANSIENT_CODES: readonly HintRejectCode[] = ['TX_NOT_FOUND', 'WITNESS_MISMATCH'];

/** How many looks of one key there were; the oldest keys are dropped past `max`. */
export class LookCounter {
  private readonly looks = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Counts this look and says how many there were, this one included. */
  count(key: string): number {
    const looks = (this.looks.get(key) ?? 0) + 1;
    this.looks.delete(key);
    this.looks.set(key, looks);
    for (const old of this.looks.keys()) {
      if (this.looks.size <= this.max) break;
      this.looks.delete(old);
    }
    return looks;
  }

  forget(key: string): void {
    this.looks.delete(key);
  }
}

/**
 * The refId of the FOREIGN_MESSAGE alert of a transfer (CR m2): `tonSeqnoUnmatched`, but not S5's
 * own job (refId = the transfer, sent when the seqno went), so the owner hears this new finding even
 * when S5's alert is long gone; one per transfer (stable id). The renderer reads the transfer back
 * through `refIdSubject`.
 */
export function foreignRef(transferId: string): string {
  return `${transferId}_foreign`;
}

/** A refusal that a later look may still turn (a source that lags), before its last look. */
export function isTransientRefusal(code: HintRejectCode, looks: number): boolean {
  return TRANSIENT_CODES.includes(code) && looks < HINT_TRANSIENT_LOOKS;
}

export type HintDestination =
  | { readonly kind: 'ACCEPT' }
  | { readonly kind: 'REJECT'; readonly code: HintRejectCode; readonly bounced: boolean }
  | { readonly kind: 'WAIT' };

/** What the destination's answer means for a hint whose transaction matched. */
export function hintDestination(
  paid: Extract<PaidStep, { readonly kind: 'PAID' }>,
  view: DestinationView,
  chainTime: number,
  graceSec: number,
): HintDestination {
  switch (view.kind) {
    case 'PROCESSED':
      return { kind: 'ACCEPT' };
    case 'ABORTED':
      return { kind: 'REJECT', code: 'DESTINATION_ABORTED', bounced: false };
    case 'BOUNCED': {
      const verdict = classifyDestination(paid, view, chainTime, graceSec);
      if (verdict.kind === 'BOUNCED') {
        return { kind: 'REJECT', code: 'DESTINATION_BOUNCED', bounced: true };
      }
      if (verdict.kind === 'SUSPECT') {
        return { kind: 'REJECT', code: 'RETURN_OUT_OF_RANGE', bounced: true };
      }
      return { kind: 'WAIT' };
    }
    case 'NOT_VISIBLE':
    case 'MISMATCH':
      return { kind: 'WAIT' };
  }
}
