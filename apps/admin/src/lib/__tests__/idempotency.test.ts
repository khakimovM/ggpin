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
