import { sameScanCursor, scanCursorJson, storedScanProgress } from '../ton-scan-cursor';
import type { ScanProgress } from '../ton-tx-scan';

// Phase 5 S9 L-2 (Q-14): the scan cursor kept in `attempt.response.ton.scan` is bound to its
// transfer AND signed message, parsed strictly, and dropped (the scan starts over: the safe
// direction) when it is not exactly this transfer's or does not look like the scan wrote it.

const hash = (c: string): string => c.repeat(64);
const TRANSFER = { id: 'cmh1transfer000000000001', extMsgHash: hash('e') };

const PROGRESS: ScanProgress = {
  covered: { lt: 100n, hash: hash('1') },
  pass: {
    anchor: {
      state: {
        status: 'active',
        balanceNano: 123_456_789_012n,
        data: Buffer.from([1, 2, 3, 250]),
        chainTime: 1_790_000_000,
        lastTx: { lt: 900n, hash: hash('9') },
      },
      atMs: 1_790_000_000_123,
    },
    next: { lt: 500n, hash: hash('5') },
  },
};

/** The response JSON as the column returns it (a JSON round trip, like Postgres). */
function stored(cursor: unknown, extra: Record<string, unknown> = {}): unknown {
  return JSON.parse(JSON.stringify({ ton: { timeout: true, ...extra, scan: cursor } })) as unknown;
}

describe('the TON scan cursor', () => {
  it('round-trips a pass in flight exactly (bigints and the data cell included)', () => {
    const back = storedScanProgress(stored(scanCursorJson(TRANSFER, PROGRESS)), TRANSFER);
    expect(back).toEqual(PROGRESS);
    expect(back?.pass?.anchor.state.data?.equals(Buffer.from([1, 2, 3, 250]))).toBe(true);
  });

  it('round-trips a finished pass and an empty one', () => {
    const done: ScanProgress = { covered: { lt: 900n, hash: hash('9') }, pass: null };
    expect(storedScanProgress(stored(scanCursorJson(TRANSFER, done)), TRANSFER)).toEqual(done);
    const none: ScanProgress = { covered: null, pass: null };
    expect(storedScanProgress(stored(scanCursorJson(TRANSFER, none)), TRANSFER)).toEqual(none);
  });

  it('is none for another transfer or another message (mutant: binding removed)', () => {
    const json = stored(scanCursorJson(TRANSFER, PROGRESS));
    expect(storedScanProgress(json, { ...TRANSFER, id: 'cmh1transfer000000000002' })).toBeNull();
    expect(storedScanProgress(json, { ...TRANSFER, extMsgHash: hash('f') })).toBeNull();
  });

  it('is none when missing, unreadable or carrying anything extra', () => {
    expect(storedScanProgress(null, TRANSFER)).toBeNull();
    expect(storedScanProgress({ ton: { timeout: true } }, TRANSFER)).toBeNull();
    const good = scanCursorJson(TRANSFER, PROGRESS);
    expect(storedScanProgress(stored({ ...good, extra: 1 }), TRANSFER)).toBeNull();
    expect(
      storedScanProgress(stored({ ...good, covered: { lt: '0100', hash: hash('1') } }), TRANSFER),
    ).toBeNull();
    expect(
      storedScanProgress(stored({ ...good, covered: { lt: 100, hash: hash('1') } }), TRANSFER),
    ).toBeNull();
    expect(
      storedScanProgress(stored({ ...good, covered: { lt: '100', hash: hash('Z') } }), TRANSFER),
    ).toBeNull();
    expect(storedScanProgress(stored({ ...good, transferId: undefined }), TRANSFER)).toBeNull();
  });

  it('is none when it could not have been written by the scan', () => {
    const json = scanCursorJson(TRANSFER, PROGRESS);
    const above: ScanProgress = { ...PROGRESS, covered: { lt: 600n, hash: hash('6') } };
    expect(storedScanProgress(stored(scanCursorJson(TRANSFER, above)), TRANSFER)).toBeNull();
    const pass = PROGRESS.pass;
    if (pass === null) throw new Error('fixture');
    const pastAnchor: ScanProgress = {
      ...PROGRESS,
      pass: { ...pass, next: { lt: 901n, hash: hash('7') } },
    };
    expect(storedScanProgress(stored(scanCursorJson(TRANSFER, pastAnchor)), TRANSFER)).toBeNull();
    const emptyAnchor: ScanProgress = {
      ...PROGRESS,
      pass: { ...pass, anchor: { ...pass.anchor, state: { ...pass.anchor.state, lastTx: null } } },
    };
    expect(storedScanProgress(stored(scanCursorJson(TRANSFER, emptyAnchor)), TRANSFER)).toBeNull();
    expect(storedScanProgress(stored(json), TRANSFER)).not.toBeNull();
  });

  it('keeps the other TON facts next to it untouched (only `scan` is read)', () => {
    const json = stored(scanCursorJson(TRANSFER, PROGRESS), { expiry: { first: { x: 1 } } });
    expect(storedScanProgress(json, TRANSFER)).toEqual(PROGRESS);
  });

  it('compares progresses as cursors', () => {
    expect(sameScanCursor(TRANSFER, PROGRESS, { ...PROGRESS })).toBe(true);
    expect(sameScanCursor(TRANSFER, PROGRESS, { ...PROGRESS, covered: null })).toBe(false);
    expect(sameScanCursor(TRANSFER, null, PROGRESS)).toBe(false);
    expect(sameScanCursor(TRANSFER, null, null)).toBe(true);
  });
});
