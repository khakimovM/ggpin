import type { TonAccountState } from '../ton-gateway';
import {
  ADVISORY_LOOKS_BEFORE_RESCAN,
  trustAfterLook,
  trustBeforeLook,
  type ScanTrust,
} from '../ton-scan-trust';
import { NO_PROGRESS, type ScanProgress, type ScanStep, type StaleCause } from '../ton-tx-scan';

// Audit L-1, third fix round (Variant A), the rules alone: only a cursor kept in the database
// (advisory) is ever forgotten; this process's own progress and the witnesses' only take what the
// scan returned, exactly as in S5 (05bff3b). ton-scan-trust-reader.spec.ts and
// ton-scan-trust-floor.spec.ts run the same rules through TonChainReader.

const T0 = 1_800_000_000;
const LIMIT = ADVISORY_LOOKS_BEFORE_RESCAN;
const hash = (byte: string): string => byte.repeat(32);
const COVERED = { lt: 100n, hash: hash('cd') };

function state(lastLt: bigint | null): TonAccountState {
  return {
    status: 'active',
    balanceNano: 1n,
    data: null,
    chainTime: T0,
    lastTx: lastLt === null ? null : { lt: lastLt, hash: hash('ab') },
  };
}

function watchOf(progress: ScanProgress, advisory: boolean): ScanTrust {
  return { progress, staleLooks: 0, gatewayLooks: 0, advisory };
}

const covering = (lt: bigint): ScanProgress => ({ covered: { lt, hash: hash('cd') }, pass: null });
/** A pass in flight above COVERED, at `nextLt`. */
const passAt = (nextLt: bigint): ScanProgress => ({
  covered: COVERED,
  pass: { anchor: { state: state(500n), atMs: null }, next: { lt: nextLt, hash: hash('ee') } },
});
/** A look that did not find our transaction (the only kind the rules see). */
type Look = Exclude<ScanStep, { readonly kind: 'FOUND' }>;

const stale = (progress: ScanProgress, cause: StaleCause): Look => ({
  kind: 'STALE',
  progress,
  cause,
});
const failed = (progress: ScanProgress): Look => ({ kind: 'PARTIAL', progress, cause: 'GATEWAY' });
const budget = (progress: ScanProgress): Look => ({ kind: 'PARTIAL', progress, cause: 'BUDGET' });
const complete = (progress: ScanProgress): Look => ({
  kind: 'COMPLETE',
  anchor: { state: state(500n), atMs: null },
  progress,
});

function looks(watch: ScanTrust, step: Look, times: number): void {
  for (let i = 0; i < times; i += 1) trustAfterLook(watch, step);
}

describe('scan trust rules: a database cursor (advisory)', () => {
  it('covering more than the fresh state knows: forgotten at once', () => {
    for (const fresh of [state(99n), state(null)]) {
      const watch = watchOf(covering(100n), true);
      trustBeforeLook(watch, fresh);
      expect(watch).toEqual(watchOf(NO_PROGRESS, false));
    }
  });

  it(`${String(LIMIT)} STALE looks (PASS or FLOOR): forgotten`, () => {
    for (const cause of ['PASS', 'FLOOR'] as const) {
      const watch = watchOf(passAt(300n), true);
      looks(watch, stale(passAt(300n), cause), LIMIT - 1);
      expect(watch).toEqual({ ...watchOf(passAt(300n), true), staleLooks: LIMIT - 1 });
      looks(watch, stale(passAt(300n), cause), 1);
      expect(watch).toEqual(watchOf(NO_PROGRESS, false));
    }
  });

  it(`${String(LIMIT)} failed listings at the same pass: forgotten (R-1)`, () => {
    const watch = watchOf(passAt(300n), true);
    looks(watch, failed(passAt(300n)), LIMIT);
    expect(watch).toEqual(watchOf(NO_PROGRESS, false));
  });

  it('a failure that moved the pass, or one without a pass, starts the count again', () => {
    const watch = watchOf(passAt(300n), true);
    looks(watch, failed(passAt(300n)), LIMIT - 1);
    trustAfterLook(watch, failed(passAt(200n)));
    expect(watch).toEqual(watchOf(passAt(200n), true));
    const head = watchOf(covering(100n), true);
    looks(head, failed(covering(100n)), LIMIT * 5);
    expect(head).toEqual(watchOf(covering(100n), true));
  });

  it('a state/index race (RACE) is never counted (R-2)', () => {
    const watch = watchOf(passAt(300n), true);
    looks(watch, stale(passAt(300n), 'RACE'), LIMIT * 5);
    expect(watch).toEqual(watchOf(passAt(300n), true));
  });

  it('a chain that skips the covered transaction (FORK): the counts and the advisory go too', () => {
    const watch = watchOf(passAt(300n), true);
    looks(watch, stale(passAt(300n), 'PASS'), LIMIT - 1);
    looks(watch, stale(NO_PROGRESS, 'FORK'), 1);
    expect(watch).toEqual(watchOf(NO_PROGRESS, false));
  });

  it('one COMPLETE or BUDGET look makes it this process’s own progress, the counts cleared', () => {
    for (const step of [budget(passAt(250n)), complete(covering(500n))]) {
      const watch = watchOf(passAt(300n), true);
      looks(watch, stale(passAt(300n), 'PASS'), LIMIT - 1);
      looks(watch, failed(passAt(300n)), LIMIT - 1);
      looks(watch, step, 1);
      expect(watch).toEqual(watchOf(step.progress, false));
      // Own progress now: nothing the chain answers drops it any more.
      looks(watch, stale(step.progress, 'PASS'), LIMIT * 5);
      expect(watch).toEqual(watchOf(step.progress, false));
    }
  });
});

describe('scan trust rules: own progress and the witnesses’ behave as in S5 (05bff3b)', () => {
  it('a state older than covered drops nothing before the look', () => {
    const watch = watchOf(covering(100n), false);
    trustBeforeLook(watch, state(99n));
    trustBeforeLook(watch, state(null));
    expect(watch).toEqual(watchOf(covering(100n), false));
  });

  it('every look only takes the scan’s progress: nothing dropped, nothing counted', () => {
    const steps: Look[] = [
      stale(covering(100n), 'FLOOR'),
      stale(passAt(300n), 'PASS'),
      stale(passAt(300n), 'RACE'),
      failed(passAt(300n)),
      failed(covering(100n)),
      stale(NO_PROGRESS, 'FORK'),
      budget(passAt(250n)),
      complete(covering(500n)),
    ];
    for (const step of steps) {
      const watch = watchOf(passAt(300n), false);
      looks(watch, step, LIMIT * 5);
      expect(watch).toEqual(watchOf(step.progress, false));
    }
  });
});
