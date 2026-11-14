import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import {
  confirmsExpiry,
  isFirstFor,
  observationJson,
  storedFirstObservation,
  type ExpiryObservation,
} from '../ton-expiry';

// D-60 (2) at each condition's boundary (review MJ1): the second observation confirms the first
// only with the same seqno, at least N s later by the database clock, a strictly later chain time
// and a last transaction that is not older. Audit L-3: a stored first counts only for its own
// transfer, message, validUntil and seqno, taken past validUntil + the margin, in a strict shape.

const N = 30;
const VALID_UNTIL_MS = 1_800_000_060_000;
const MARGIN_SEC = TON_NOT_SENT_MARGIN_MS / 1_000;

const FIRST: ExpiryObservation = {
  transferId: 'cm0transfer1',
  extMsgHash: 'ab'.repeat(32),
  validUntilMs: VALID_UNTIL_MS,
  chainTime: VALID_UNTIL_MS / 1_000 + MARGIN_SEC + 1,
  atMs: VALID_UNTIL_MS + TON_NOT_SENT_MARGIN_MS,
  seqno: 7,
  lastTxLt: 5_000n,
};

/** A second observation that confirms FIRST; each test moves one condition to its boundary. */
function second(patch: Partial<ExpiryObservation> = {}): ExpiryObservation {
  return { ...FIRST, chainTime: FIRST.chainTime + N, atMs: FIRST.atMs + N * 1_000, ...patch };
}

describe('confirmsExpiry (D-60 (2))', () => {
  it('the reference pair confirms', () => {
    expect(confirmsExpiry(FIRST, second(), N)).toBe(true);
  });

  it('gap: N*1000 ms confirms, N*1000 - 1 ms does not', () => {
    expect(confirmsExpiry(FIRST, second({ atMs: FIRST.atMs + N * 1_000 }), N)).toBe(true);
    expect(confirmsExpiry(FIRST, second({ atMs: FIRST.atMs + N * 1_000 - 1 }), N)).toBe(false);
  });

  it('chain time: equal does not confirm, one second later does', () => {
    expect(confirmsExpiry(FIRST, second({ chainTime: FIRST.chainTime }), N)).toBe(false);
    expect(confirmsExpiry(FIRST, second({ chainTime: FIRST.chainTime + 1 }), N)).toBe(true);
  });

  it('last transaction: lt - 1 does not confirm, the same lt does', () => {
    expect(confirmsExpiry(FIRST, second({ lastTxLt: FIRST.lastTxLt - 1n }), N)).toBe(false);
    expect(confirmsExpiry(FIRST, second({ lastTxLt: FIRST.lastTxLt }), N)).toBe(true);
  });

  it('another seqno (one more or one less) never confirms', () => {
    expect(confirmsExpiry(FIRST, second({ seqno: FIRST.seqno + 1 }), N)).toBe(false);
    expect(confirmsExpiry(FIRST, second({ seqno: FIRST.seqno - 1 }), N)).toBe(false);
  });
});

/** An attempt response as the JSON column holds it, with other facts next to the first. */
function storedWith(first: unknown): unknown {
  return { fragment: { kept: 1 }, ton: { expiry: { first } } };
}

describe('the stored first observation (audit L-3)', () => {
  const next = second();

  it('round-trips through the attempt response', () => {
    expect(storedFirstObservation(storedWith(observationJson(FIRST)), next)).toEqual(FIRST);
  });

  it.each<[string, Partial<ExpiryObservation>]>([
    ['another transfer', { transferId: 'cm0transfer2' }],
    ['another message', { extMsgHash: 'cd'.repeat(32) }],
    ['another validUntil', { validUntilMs: VALID_UNTIL_MS + 1_000 }],
    ['another seqno', { seqno: 6 }],
    ['taken 1 ms before validUntil + the margin', { atMs: FIRST.atMs - 1 }],
    ['a chain time not past validUntil + the margin', { chainTime: FIRST.chainTime - 1 }],
    ['taken after the next observation (a clock stepped back)', { atMs: next.atMs + 1 }],
  ])('%s: no first (the next look becomes the first)', (_name, patch) => {
    const forged = { ...FIRST, ...patch };
    expect(isFirstFor(forged, next)).toBe(false);
    expect(storedFirstObservation(storedWith(observationJson(forged)), next)).toBeNull();
  });

  it('the strict shape: an extra key, a missing key or a malformed value is no first', () => {
    const json = observationJson(FIRST);
    const { transferId: _dropped, ...withoutTransfer } = json;
    for (const bad of [
      { ...json, note: 'x' },
      withoutTransfer,
      { ...json, lastTxLt: '-1' },
      { ...json, extMsgHash: 'AB'.repeat(32) },
      'x',
    ]) {
      expect(storedFirstObservation(storedWith(bad), next)).toBeNull();
    }
    expect(storedFirstObservation(null, next)).toBeNull();
    expect(storedFirstObservation({}, next)).toBeNull();
  });

  it('the forged old first of the re-audit (no binding, epoch times) is no first', () => {
    const forged = { chainTime: 1, atMs: 1, seqno: 7, lastTxLt: '0' };
    expect(storedFirstObservation(storedWith(forged), next)).toBeNull();
  });
});
