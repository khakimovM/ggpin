import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Registry = typeof import('../idempotency');
const ADMIN = 'cmadminowner01';
const OTHER_ADMIN = 'cmadminoperator01';

/** A fresh copy of the module, as after a reload of the tab (it reads sessionStorage on load). */
async function reload(): Promise<Registry> {
  vi.resetModules();
  return import('../idempotency');
}

let seq = 0;
function target(): string {
  seq += 1;
  return `user_${seq}`;
}

// The first import transforms @repo/shared and zod: slow on a loaded machine (full verify), so
// it is done once here with its own budget instead of inside the first test.
beforeAll(async () => {
  await import('../idempotency');
}, 30_000);

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('adminActionId', () => {
  it('joins the admin, a known kind and a valid target id', async () => {
    const { adminActionId } = await reload();
    expect(adminActionId(ADMIN, 'users.adjustWallet', 'cmuser01')).toBe(
      'cmadminowner01/users.adjustWallet:cmuser01',
    );
  });

  it('refuses an admin or target id that is not a resource id', async () => {
    const { adminActionId } = await reload();
    expect(() => adminActionId('', 'orders.refund', 'abc')).toThrow();
    expect(() => adminActionId('a/b', 'orders.refund', 'abc')).toThrow();
    expect(() => adminActionId(ADMIN, 'orders.refund', '')).toThrow();
    expect(() => adminActionId(ADMIN, 'orders.refund', 'a:b')).toThrow();
    expect(() => adminActionId(ADMIN, 'orders.refund', 'x'.repeat(65))).toThrow();
  });
});

describe('the key registry', () => {
  it('keeps one key per action until a 2xx for that key', async () => {
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'users.adjustWallet', target());
    const first = r.actionIdempotencyKey(action);
    expect(r.beginActionAttempt(action)).toBe(first);
    r.endRefusedAttempt(action, first);
    expect(r.actionIdempotencyKey(action)).toBe(first);
    r.settleActionIdempotencyKey(action, first);
    expect(r.pendingAction(action)).toBeNull();
    expect(r.actionIdempotencyKey(action)).not.toBe(first);
  });

  it('another admin never sees or uses this admin entry, and it is not deleted (CR #3)', async () => {
    const r = await reload();
    const id = target();
    const mine = r.adminActionId(ADMIN, 'orders.refund', id);
    const key = r.beginActionAttempt(mine);
    r.markActionOutcomeUnknown(mine, key, { reason: 'Sabab matni bor', conflict: false });
    const theirs = r.adminActionId(OTHER_ADMIN, 'orders.refund', id);
    expect(r.pendingAction(theirs)).toBeNull();
    expect(r.actionIdempotencyKey(theirs)).not.toBe(key);
    expect(r.pendingAction(mine)).toMatchObject({ key, unknown: true });
  });

  it('a late 2xx for an old key does not remove the newer entry', async () => {
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'orders.refund', target());
    const old = r.actionIdempotencyKey(action);
    r.settleActionIdempotencyKey(action, old);
    const current = r.actionIdempotencyKey(action);
    r.settleActionIdempotencyKey(action, old);
    expect(r.pendingAction(action)?.key).toBe(current);
  });

  it('marking an unknown outcome creates the entry when it is gone (dialog unmounted)', async () => {
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'orders.cancel', target());
    const key = r.createIdempotencyKey();
    r.markActionOutcomeUnknown(action, key, { reason: 'Sabab matni bor', conflict: false });
    expect(r.pendingAction(action)).toEqual({
      key,
      reason: 'Sabab matni bor',
      unknown: true,
      conflict: false,
    });
  });

  it('an entry holding another key keeps its key, reason and conflict flag (CR #5)', async () => {
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'orders.cancel', target());
    const current = r.beginActionAttempt(action);
    r.markActionOutcomeUnknown(action, current, { reason: 'Birinchi sabab', conflict: true });
    r.markActionOutcomeUnknown(action, r.createIdempotencyKey(), {
      reason: 'Boshqa urinish',
      conflict: false,
    });
    expect(r.pendingAction(action)).toEqual({
      key: current,
      reason: 'Birinchi sabab',
      unknown: true,
      conflict: true,
    });
  });

  it('a confirmed sign-out drops only plain entries (SA L-1)', async () => {
    const r = await reload();
    const plain = r.adminActionId(ADMIN, 'orders.cancel', target());
    r.actionIdempotencyKey(plain);
    const unknown = r.adminActionId(ADMIN, 'orders.cancel', target());
    r.markActionOutcomeUnknown(unknown, r.beginActionAttempt(unknown), {
      reason: 'Sabab matni bor',
      conflict: false,
    });
    const conflict = r.adminActionId(ADMIN, 'orders.refund', target());
    r.markActionOutcomeUnknown(conflict, r.beginActionAttempt(conflict), {
      reason: 'Sabab matni bor',
      conflict: true,
    });
    r.dropPlainActions();
    expect(r.pendingAction(plain)).toBeNull();
    expect(r.pendingAction(unknown)?.unknown).toBe(true);
    expect(r.pendingAction(conflict)?.conflict).toBe(true);
  });
});

describe('the 60 s bound of "start as a new action" (SA-2, R-1, R-2)', () => {
  it('in this tab, the smaller of the wall and the monotonic clock counts', async () => {
    const r = await reload();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const mono = vi.spyOn(performance, 'now').mockReturnValue(500);
    const action = r.adminActionId(ADMIN, 'payments.reverse', target());
    const { key, attempt } = r.beginAttempt(action);
    r.markActionOutcomeUnknown(action, key, { reason: 'x', conflict: false, attempt });
    const mark = r.pendingAttemptMark(action) ?? '';
    // The wall clock jumped an hour forward, the monotonic one moved 10 s.
    wall.mockReturnValue(1_000_000 + 3_600_000);
    mono.mockReturnValue(10_500);
    expect(r.pendingElapsedMs(action)).toBe(10_000);
    expect(r.restartAction(action, key, 60_000, mark, 10_000)).toBeNull();
    mono.mockReturnValue(60_500);
    expect(r.restartAction(action, key, 60_000, mark, 60_000)).not.toBeNull();
    vi.restoreAllMocks();
  });

  it('a verdict made before a later attempt with the same key replaces nothing (R-1)', async () => {
    const r = await reload();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    const mono = vi.spyOn(performance, 'now').mockReturnValue(0);
    const action = r.adminActionId(ADMIN, 'payments.reverse', target());
    const first = r.beginAttempt(action);
    r.markActionOutcomeUnknown(action, first.key, { reason: 'x', conflict: false, attempt: 1 });
    const searchedAfter = r.pendingAttemptMark(action) ?? '';
    // The old search said "not found"; the admin sends again with the same key, again unknown.
    wall.mockReturnValue(3_061_000);
    mono.mockReturnValue(61_000);
    const second = r.beginAttempt(action);
    expect(second.key).toBe(first.key);
    r.markActionOutcomeUnknown(action, second.key, { reason: 'x', conflict: false, attempt: 2 });
    wall.mockReturnValue(3_122_000);
    mono.mockReturnValue(122_000);
    expect(r.restartAction(action, first.key, 60_000, searchedAfter, 61_000)).toBeNull();
    expect(r.pendingAction(action)?.key).toBe(first.key);
    vi.restoreAllMocks();
  });

  it('after a reload the wait counts from the reload too; a future wall time is "just now" (R-2)', async () => {
    const before = await reload();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const mono = vi.spyOn(performance, 'now').mockReturnValue(0);
    const action = before.adminActionId(ADMIN, 'payments.reverse', target());
    before.beginAttempt(action);
    // The page is reloaded at monotonic 5 000 (a new document: its clock is fresh).
    mono.mockReturnValue(5_000);
    const after = await reload();
    wall.mockReturnValue(2_000_000 - 30_000);
    expect(after.pendingElapsedMs(action)).toBe(0);
    // The wall clock says an hour passed, but only 10 s did since the reload.
    wall.mockReturnValue(2_000_000 + 3_600_000);
    mono.mockReturnValue(15_000);
    expect(after.pendingElapsedMs(action)).toBe(10_000);
    mono.mockReturnValue(66_000);
    expect(after.pendingElapsedMs(action)).toBe(61_000);
    vi.restoreAllMocks();
  });
});
