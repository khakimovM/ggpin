import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Registry = typeof import('../idempotency');
const STORAGE_KEY = 'ggpin-admin-pending-actions';
const ADMIN = 'cmadminowner01';

/** A fresh copy of the module, as after a reload of the tab (it reads sessionStorage on load). */
async function reload(): Promise<Registry> {
  vi.resetModules();
  return import('../idempotency');
}

const stored = () => window.sessionStorage.getItem(STORAGE_KEY);

let seq = 0;
function target(): string {
  seq += 1;
  return `store_${seq}`;
}

// The first import transforms @repo/shared and zod: slow on a loaded machine (full verify), so
// it is done once here with its own budget instead of inside the first test.
beforeAll(async () => {
  await import('../idempotency');
}, 30_000);

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sessionStorage of the key registry', () => {
  it('writes ahead: an attempt is stored before the answer, without the reason (SA M-2)', async () => {
    const r = await reload();
    r.actionIdempotencyKey(r.adminActionId(ADMIN, 'users.adjustWallet', target()));
    expect(stored()).toBeNull();
    const id = target();
    const key = r.beginActionAttempt(r.adminActionId(ADMIN, 'users.adjustWallet', id));
    expect(JSON.parse(stored() ?? '[]')).toEqual([
      {
        adminId: ADMIN,
        kind: 'users.adjustWallet',
        targetId: id,
        key,
        unknown: false,
        conflict: false,
        inFlight: true,
        createdAt: expect.any(Number) as number,
      },
    ]);
  });

  it('a reload while the request is out brings the same key back as unknown', async () => {
    const before = await reload();
    const id = target();
    const key = before.beginActionAttempt(before.adminActionId(ADMIN, 'orders.refund', id));
    const after = await reload();
    expect(after.pendingAction(after.adminActionId(ADMIN, 'orders.refund', id))).toEqual({
      key,
      reason: null,
      unknown: true,
      conflict: false,
    });
  });

  it('a definite refusal removes a plain attempt from storage but keeps an unknown one', async () => {
    const r = await reload();
    const plain = r.adminActionId(ADMIN, 'orders.cancel', target());
    const plainKey = r.beginActionAttempt(plain);
    r.endRefusedAttempt(plain, plainKey);
    expect(stored()).toBeNull();
    expect(r.pendingAction(plain)?.key).toBe(plainKey);

    const unknown = r.adminActionId(ADMIN, 'orders.cancel', target());
    const key = r.beginActionAttempt(unknown);
    r.markActionOutcomeUnknown(unknown, key, { reason: 'Maxfiy sabab matni', conflict: false });
    r.endRefusedAttempt(unknown, r.beginActionAttempt(unknown));
    expect(stored()).toContain(key);
    expect(stored()).not.toContain('Maxfiy');
  });

  it.each([
    'orders.cancel',
    'orders.failAndRefund',
    'orders.refund',
    'payments.reverse',
    'orders.resolve',
    'payments.reviewCredit',
    'users.adjustWallet',
    'cards.resume',
    'fx.set',
    'admins.create',
    'admins.update',
    'admins.sessionsRevoke',
    'sessions.revoke',
  ] as const)('round-trips an unknown %s entry through a reload (SA I-1)', async (kind) => {
    const before = await reload();
    expect(before.ADMIN_ACTION_KINDS).toContain(kind);
    const action = before.adminActionId(ADMIN, kind, 'USDT_UZS');
    const key = before.beginActionAttempt(action);
    before.markActionOutcomeUnknown(action, key, { reason: 'Sabab matni bor', conflict: true });
    const after = await reload();
    expect(after.pendingAction(after.adminActionId(ADMIN, kind, 'USDT_UZS'))).toEqual({
      key,
      reason: null,
      unknown: true,
      conflict: true,
    });
  });

  it('drops a broken value and keeps only the valid entries', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '{not json');
    const broken = await reload();
    expect(broken.pendingAction(broken.adminActionId(ADMIN, 'orders.refund', 'abc'))).toBeNull();

    const valid = {
      adminId: ADMIN,
      kind: 'orders.refund',
      targetId: 'good_1',
      key: 'k_12345678',
      unknown: true,
      conflict: false,
      inFlight: false,
      createdAt: 1,
    };
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        valid,
        { ...valid, targetId: 'bad id' },
        { ...valid, targetId: 'bad_2', key: 'short' },
        { ...valid, targetId: 'bad_3', reason: 'extra field' },
        { ...valid, targetId: 'bad_4', kind: 'orders.unknownKind' },
        { ...valid, targetId: 'bad_5', adminId: '' },
      ]),
    );
    const r = await reload();
    expect(r.pendingAction(r.adminActionId(ADMIN, 'orders.refund', 'good_1'))?.key).toBe(
      'k_12345678',
    );
    for (const bad of ['bad_2', 'bad_3', 'bad_4']) {
      expect(r.pendingAction(r.adminActionId(ADMIN, 'orders.refund', bad))).toBeNull();
    }
    // The next write keeps only what was valid: no unknown kind, no bad id comes back.
    r.beginActionAttempt(r.adminActionId(ADMIN, 'orders.cancel', target()));
    const rewritten = stored() ?? '';
    expect(rewritten).toContain('good_1');
    for (const bad of ['unknownKind', 'bad id', 'bad_2', 'bad_3', 'bad_5']) {
      expect(rewritten).not.toContain(bad);
    }
  });

  it('works from memory when the storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'orders.cancel', target());
    const key = r.beginActionAttempt(action);
    r.markActionOutcomeUnknown(action, key, { reason: 'Sabab matni bor', conflict: false });
    expect(r.pendingAction(action)).toMatchObject({ key, unknown: true });
  });

  it('a confirmed sign-out keeps the unknown entries in storage too', async () => {
    const r = await reload();
    const action = r.adminActionId(ADMIN, 'orders.cancel', target());
    const key = r.beginActionAttempt(action);
    r.markActionOutcomeUnknown(action, key, { reason: 'Sabab matni bor', conflict: false });
    r.dropPlainActions();
    expect(stored()).toContain(key);
  });
});
