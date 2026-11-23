import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// N-1: a search verdict given while an attempt of the same key is still out must never open a
// new key (the attempt may reach the server later and move money a second time).
type Registry = typeof import('../idempotency');
const ADMIN = 'cmadminowner01';
const WAIT = 60_000;
const T0 = 5_000_000;

async function reload(): Promise<Registry> {
  vi.resetModules();
  return import('../idempotency');
}

let seq = 0;
function target(): string {
  seq += 1;
  return `n1_${seq}`;
}

/** Both clocks at `ms` after T0 (monotonic 0 = T0). */
function clocksAt(ms: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(T0 + ms);
  vi.spyOn(performance, 'now').mockReturnValue(ms);
}

beforeAll(async () => {
  await import('../idempotency');
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('N-1: verdicts made while an attempt is out', () => {
  it('unknown -> resend hangs -> a search 61 s later -> the resend ends unknown: the key stays', async () => {
    const r = await reload();
    clocksAt(0);
    const action = r.adminActionId(ADMIN, 'users.adjustWallet', target());
    const first = r.beginAttempt(action);
    r.markActionOutcomeUnknown(action, first.key, { reason: 'x', conflict: false, attempt: 1 });
    const second = r.beginAttempt(action); // hangs
    clocksAt(61_000);
    expect(r.pendingInFlight(action)).toBe(true);
    const mark = r.pendingAttemptMark(action) ?? '';
    const elapsed = r.pendingElapsedMs(action) ?? 0;
    expect(elapsed).toBe(61_000);
    // (3) Refused while the resend is out.
    expect(r.restartAction(action, first.key, WAIT, mark, elapsed)).toBeNull();
    // The resend ends with an unknown outcome (no answer).
    r.markActionOutcomeUnknown(action, second.key, { reason: 'x', conflict: false, attempt: 2 });
    expect(r.pendingInFlight(action)).toBe(false);
    // (2) The wait counts from the end: a fresh search now is too early.
    const fresh = r.pendingElapsedMs(action) ?? 0;
    expect(fresh).toBe(0);
    expect(
      r.restartAction(action, first.key, WAIT, r.pendingAttemptMark(action) ?? '', fresh),
    ).toBeNull();
    // (4) The verdict given while the resend was out is void after its end, even 61 s later.
    clocksAt(122_000);
    expect(r.pendingAttemptMark(action)).not.toBe(mark);
    expect(r.restartAction(action, first.key, WAIT, mark, elapsed)).toBeNull();
    expect(r.pendingAction(action)?.key).toBe(first.key);
  });

  it('attempt N-1 hangs, attempt N gets a fast 4xx: the key is still out and stays', async () => {
    const r = await reload();
    clocksAt(0);
    const action = r.adminActionId(ADMIN, 'payments.reverse', target());
    const older = r.beginAttempt(action); // closed dialog: its request is still on its way
    const newer = r.beginAttempt(action);
    expect(newer.key).toBe(older.key);
    r.endRefusedAttempt(action, newer.key, newer.attempt);
    clocksAt(61_000);
    expect(r.pendingInFlight(action)).toBe(true);
    const mark = r.pendingAttemptMark(action) ?? '';
    expect(r.restartAction(action, older.key, WAIT, mark, 61_000)).toBeNull();
    expect(r.pendingAction(action)?.key).toBe(older.key);
    // The older answer arriving late (a 4xx) ends the last one out.
    r.endRefusedAttempt(action, older.key, older.attempt);
    expect(r.pendingInFlight(action)).toBe(false);
  });

  it('the timeout path: an attempt ended by the timeout waits 60 s from the timeout', async () => {
    const r = await reload();
    clocksAt(0);
    const action = r.adminActionId(ADMIN, 'payments.reviewCredit', target());
    const sent = r.beginAttempt(action);
    // WRITE_TIMEOUT_MS later the form gets NETWORK: the outcome is unknown.
    clocksAt(30_000);
    r.markActionOutcomeUnknown(action, sent.key, { reason: 'x', conflict: false, attempt: 1 });
    clocksAt(61_000);
    // 61 s after the send, but only 31 s after the timeout: still closed.
    expect(r.pendingElapsedMs(action)).toBe(31_000);
    const mark = r.pendingAttemptMark(action) ?? '';
    expect(r.restartAction(action, sent.key, WAIT, mark, 31_000)).toBeNull();
    expect(r.pendingAction(action)?.key).toBe(sent.key);
    clocksAt(90_000);
    expect(r.restartAction(action, sent.key, WAIT, mark, 60_000)).not.toBeNull();
  });

  it('restartAction checks the elapsed time of the search itself too (SA S7b-I2)', async () => {
    const r = await reload();
    clocksAt(0);
    const action = r.adminActionId(ADMIN, 'payments.reverse', target());
    const sent = r.beginAttempt(action);
    r.markActionOutcomeUnknown(action, sent.key, { reason: 'x', conflict: false, attempt: 1 });
    const mark = r.pendingAttemptMark(action) ?? '';
    clocksAt(70_000);
    // The search ran 10 s after the end (the row could still have been written after it).
    expect(r.restartAction(action, sent.key, WAIT, mark, 10_000)).toBeNull();
    expect(r.pendingAction(action)?.key).toBe(sent.key);
  });

  it('after a reload nothing is out, and the wait counts from the reload (R-2)', async () => {
    const before = await reload();
    clocksAt(0);
    const action = before.adminActionId(ADMIN, 'payments.reverse', target());
    before.beginAttempt(action);
    clocksAt(100_000);
    vi.spyOn(performance, 'now').mockReturnValue(0); // a new document: its clock is fresh
    const after = await reload();
    expect(after.pendingInFlight(action)).toBe(false);
    expect(after.pendingAction(action)?.unknown).toBe(true);
    expect(after.pendingElapsedMs(action)).toBe(0);
  });
});
