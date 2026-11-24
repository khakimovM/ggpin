import { AdminWriteKeyVoidResponseSchema, CSRF_HEADER } from '@repo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectedAuditId } from '../../../idempotency-outcome';
import { MOCK_JOURNAL_KEY, readJournal } from '../mock-journal';
import { MOCK_STATE_KEY, writeMockState } from '../mock-state';
import { createMockTransport } from '../transport';

// The mock key void behaves like docs/04 «Kalitni bekor qilish»: the shared schemas, APPLIED for
// a committed key, VOIDED (once, idempotent) otherwise, a voided key is 409 for every write, a
// role without the action is 404, and the one-shot scenarios for the 503 deadline and the 404.

const BASE = 'http://localhost:5000/api/v1';
const transport = createMockTransport({
  apiBaseUrl: BASE,
  now: () => new Date('2026-11-24T09:00:00Z'),
});
const OWNER_ID = 'cmadminownermock000000001';
const REASON = 'Shubhali faollik, tekshiruv';

async function post(path: string, body: unknown, key?: string) {
  const response = await transport({
    method: 'POST',
    url: `${BASE}${path}`,
    headers: {
      [CSRF_HEADER]: 'csrf',
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });
  return response as {
    status: number;
    body: { success: boolean; data?: unknown; error?: { code: string } };
  };
}

const block = (key: string) => post('/admin/users/mkuser000001/block', { reason: REASON }, key);
const voidKey = (key: string, action = 'users.block') =>
  post('/admin/write-keys/void', { idempotencyKey: key, action, targetId: 'mkuser000001' });

beforeEach(() => {
  window.sessionStorage.removeItem(MOCK_JOURNAL_KEY);
  window.sessionStorage.removeItem(MOCK_STATE_KEY);
  writeMockState({ signedIn: true, role: 'OWNER', writeScenario: 'ok', voidScenario: 'ok' });
});

describe('mock key void', () => {
  it('a committed key is APPLIED with its own audit row and action', async () => {
    await block('key_void_0001');
    const answer = await voidKey('key_void_0001');
    expect(answer.status).toBe(200);
    expect(AdminWriteKeyVoidResponseSchema.parse(answer.body.data)).toEqual({
      status: 'APPLIED',
      auditId: await expectedAuditId(OWNER_ID, 'key_void_0001'),
      action: 'USER_BLOCK',
      at: '2026-11-24T09:00:00.000Z',
    });
  });

  it('an unused key is VOIDED once; every later write with it is 409, the same body too', async () => {
    const first = AdminWriteKeyVoidResponseSchema.parse((await voidKey('key_void_0002')).body.data);
    expect(first.status).toBe('VOIDED');
    expect(first.auditId).toBe(await expectedAuditId(OWNER_ID, 'key_void_0002'));
    const again = AdminWriteKeyVoidResponseSchema.parse((await voidKey('key_void_0002')).body.data);
    expect(again).toEqual(first);
    expect(readJournal().audit.filter((row) => row.action === 'IDEMPOTENCY_VOID')).toHaveLength(1);
    const write = await block('key_void_0002');
    expect(write.status).toBe(409);
    expect(write.body.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(readJournal().users.mkuser000001).toBeUndefined();
  });

  it('a key the role cannot use is 404 and writes no tombstone', async () => {
    writeMockState({ role: 'SUPPORT' });
    const answer = await voidKey('key_void_0003');
    expect(answer.status).toBe(404);
    expect(readJournal().voided).toEqual({});
  });

  it('a bad body is 400 (shared schema): a read permission is not a keyed write', async () => {
    const answer = await voidKey('key_void_0004', 'audit.read');
    expect(answer.status).toBe(400);
  });

  it('the one-shot void scenarios: 503 deadline and 404, nothing written', async () => {
    writeMockState({ voidScenario: 'deadline503' });
    const late = await voidKey('key_void_0005');
    expect(late.status).toBe(503);
    expect(late.body.error?.code).toBe('ADMIN_DEADLINE_EXCEEDED');
    writeMockState({ voidScenario: 'notFound' });
    expect((await voidKey('key_void_0005')).status).toBe(404);
    expect(readJournal().voided).toEqual({});
    expect((await voidKey('key_void_0005')).status).toBe(200);
  });

  it('a write deadline 503 writes nothing and leaves the key free', async () => {
    writeMockState({ writeScenario: 'deadline503' });
    const late = await block('key_void_0006');
    expect(late.status).toBe(503);
    expect(late.body.error?.code).toBe('ADMIN_DEADLINE_EXCEEDED');
    expect(readJournal().users.mkuser000001).toBeUndefined();
    expect((await block('key_void_0006')).status).toBe(200);
  });
});
