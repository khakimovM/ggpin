import { describe, expect, it } from 'vitest';
import {
  ADMIN_KEYED_WRITE_PERMISSIONS,
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_KEYS,
  AdminWriteKeyVoidBodySchema,
  AdminWriteKeyVoidResponseSchema,
  IDEMPOTENCY_VOID_ACTION,
  isAuditSecretKey,
} from './index';

// 9-B SA-1: `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish»).
const BODY = { idempotencyKey: 'k_12345678', action: 'users.block', targetId: 'u1' } as const;
const ok = (value: unknown): boolean => AdminWriteKeyVoidBodySchema.safeParse(value).success;

describe('keyed admin writes', () => {
  it('are exactly the matrix writes without confirmations.create and the void itself', () => {
    const writes = ADMIN_PERMISSION_KEYS.filter(
      (key) =>
        ADMIN_PERMISSIONS[key].write && key !== 'confirmations.create' && key !== 'writeKeys.void',
    );
    expect([...ADMIN_KEYED_WRITE_PERMISSIONS].sort()).toEqual([...writes].sort());
  });

  it('the void writes the IDEMPOTENCY_VOID tombstone, and its `after` key is shown', () => {
    expect(ADMIN_PERMISSIONS['writeKeys.void'].auditActions).toEqual([IDEMPOTENCY_VOID_ACTION]);
    expect(ADMIN_PERMISSIONS['writeKeys.void'].roles).toEqual(['OWNER', 'OPERATOR', 'SUPPORT']);
    expect(isAuditSecretKey('voidedAction')).toBe(false);
  });
});

describe('void body', () => {
  it('takes a key, a keyed action and a target', () => {
    expect(ok(BODY)).toBe(true);
    for (const action of ADMIN_KEYED_WRITE_PERMISSIONS) expect(ok({ ...BODY, action })).toBe(true);
  });

  it('is strict and refuses the code issuer, the void, reads and unknown actions', () => {
    expect(ok({ ...BODY, extra: 1 })).toBe(false);
    for (const action of ['confirmations.create', 'writeKeys.void', 'users.read', 'nope']) {
      expect(ok({ ...BODY, action }), action).toBe(false);
    }
  });

  it('checks the key like the header (8-128 of A-Z a-z 0-9 _ -) and the target id', () => {
    expect(ok({ ...BODY, idempotencyKey: 'short' })).toBe(false);
    expect(ok({ ...BODY, idempotencyKey: 'x'.repeat(129) })).toBe(false);
    expect(ok({ ...BODY, idempotencyKey: 'x'.repeat(128) })).toBe(true);
    expect(ok({ ...BODY, idempotencyKey: 'bad key!' })).toBe(false);
    expect(ok({ ...BODY, targetId: '../x' })).toBe(false);
    for (const field of ['idempotencyKey', 'action', 'targetId'] as const) {
      const rest: Record<string, string> = { ...BODY };
      delete rest[field];
      expect(ok(rest), field).toBe(false);
    }
  });
});

describe('void response', () => {
  const at = '2026-11-23T10:00:00.000Z';
  it('is VOIDED without an action or APPLIED with one, nothing else', () => {
    const parse = (value: unknown) => AdminWriteKeyVoidResponseSchema.safeParse(value).success;
    expect(parse({ status: 'VOIDED', auditId: 'a1', at })).toBe(true);
    expect(parse({ status: 'APPLIED', auditId: 'a1', action: 'WALLET_ADJUST', at })).toBe(true);
    expect(parse({ status: 'VOIDED', auditId: 'a1', action: 'WALLET_ADJUST', at })).toBe(false);
    expect(parse({ status: 'APPLIED', auditId: 'a1', at })).toBe(false);
    expect(parse({ status: 'UNKNOWN', auditId: 'a1', at })).toBe(false);
  });
});
