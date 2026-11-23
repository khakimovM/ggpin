import {
  AdminCardChangeResponseSchema,
  AdminConfirmationResponseSchema,
  AdminNoteResponseSchema,
  AdminUserStateResponseSchema,
  CSRF_HEADER,
} from '@repo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectedAuditId } from '../../../idempotency-outcome';
import { MOCK_JOURNAL_KEY } from '../mock-journal';
import { MOCK_STATE_KEY, writeMockState } from '../mock-state';
import { createMockTransport } from '../transport';

// The mock write frame behaves like the API (plan 5.1): replay, 409, a 4xx writes nothing, the
// audit id from the key, codes bound to the body, OTP_NOT_REQUIRED, one-shot write scenarios.

const BASE = 'http://localhost:5000/api/v1';
const transport = createMockTransport({
  apiBaseUrl: BASE,
  now: () => new Date('2026-11-17T09:00:00Z'),
});
const OWNER_ID = 'cmadminownermock000000001';

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
    body: { success: boolean; data?: unknown; error?: { code: string; details?: unknown } };
  };
}

const block = (key: string, reason = 'Shubhali faollik, tekshiruv') =>
  post('/admin/users/mkuser000001/block', { reason }, key);

beforeEach(() => {
  window.sessionStorage.removeItem(MOCK_JOURNAL_KEY);
  window.sessionStorage.removeItem(MOCK_STATE_KEY);
  writeMockState({ signedIn: true, role: 'OWNER', writeScenario: 'ok' });
});

describe('mock write frame', () => {
  it('applies once; the same key and body replays the first result with applied: false', async () => {
    const first = await block('key_block_0001');
    const data = AdminUserStateResponseSchema.parse(first.body.data);
    expect(data).toMatchObject({ applied: true, isBlocked: true, revokedSessions: 2 });
    expect(data.auditId).toBe(await expectedAuditId(OWNER_ID, 'key_block_0001'));
    const again = AdminUserStateResponseSchema.parse((await block('key_block_0001')).body.data);
    expect(again).toMatchObject({ applied: false, auditId: data.auditId });
  });

  it('another body with the same key is 409; a new key on a blocked user is a no-op', async () => {
    await block('key_block_0002');
    expect((await block('key_block_0002', 'Boshqa sabab bilan yuborildi')).body.error?.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    const noop = AdminUserStateResponseSchema.parse((await block('key_block_0003')).body.data);
    expect(noop).toMatchObject({ applied: false, auditId: null });
  });

  it('refuses a missing key and a bad body, writing nothing', async () => {
    expect(
      (await post('/admin/users/mkuser000001/block', { reason: 'Shubhali faollik' })).status,
    ).toBe(400);
    expect((await block('key_block_0004', 'qisqa')).status).toBe(400);
    expect(window.sessionStorage.getItem(MOCK_JOURNAL_KEY)).toBeNull();
  });

  it('a code is bound to its body; a wrong body or code is refused, OTP_NOT_REQUIRED where none is needed', async () => {
    const card = 'mkcard000001';
    const issued = await post('/admin/confirmations', {
      action: 'cards.retire',
      targetId: card,
      emergency: false,
    });
    const { challengeId } = AdminConfirmationResponseSchema.parse(issued.body.data);
    const wrongBody = await post(
      `/admin/payments/cards/${card}/retire`,
      {
        reason: 'Karta yopildi, almashtiriladi',
        emergency: true,
        otp: { challengeId, code: '123456' },
      },
      'key_retire_0001',
    );
    expect(wrongBody.body.error?.code).toBe('CODE_INVALID');
    const done = await post(
      `/admin/payments/cards/${card}/retire`,
      {
        reason: 'Karta yopildi, almashtiriladi',
        emergency: false,
        otp: { challengeId, code: '123456' },
      },
      'key_retire_0002',
    );
    expect(AdminCardChangeResponseSchema.parse(done.body.data).card.status).toBe('DRAINING');
    const notNeeded = await post('/admin/confirmations', {
      action: 'cards.limit',
      targetId: card,
      receiveLimitTiyin: '90000000000',
    });
    expect(notNeeded.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: [{ path: 'action', code: 'OTP_NOT_REQUIRED' }] },
    });
  });

  it('applyThen500 applies and answers 500 once; the resend replays', async () => {
    writeMockState({ writeScenario: 'applyThen500' });
    expect((await block('key_block_0005')).status).toBe(500);
    const replay = AdminUserStateResponseSchema.parse((await block('key_block_0005')).body.data);
    expect(replay.applied).toBe(false);
    expect(replay.auditId).not.toBeNull();
  });

  it('a note answers the strict shared shape; its id is the audit id', async () => {
    writeMockState({ role: 'SUPPORT' });
    const response = await post(
      '/admin/users/mkuser000001/notes',
      { text: 'Qo‘ng‘iroq qilindi' },
      'key_note_0001',
    );
    const data = AdminNoteResponseSchema.parse(response.body.data);
    expect(data.note.author).toEqual({
      id: 'cmadminsupportmock0000000',
      name: expect.any(String) as string,
    });
    expect(data.note.id).toBe(data.auditId);
  });

  it('the audit route finds the row by actorId and targetId', async () => {
    await block('key_block_0006');
    const response = await transport({
      method: 'GET',
      url: `${BASE}/admin/audit-log?actorId=${OWNER_ID}&targetId=mkuser000001`,
      headers: {},
    });
    const rows = (response.body as { data: { id: string }[] }).data;
    expect(rows.map((row) => row.id)).toEqual([await expectedAuditId(OWNER_ID, 'key_block_0006')]);
  });
});
