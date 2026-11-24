import {
  AdminAccountListResponseSchema,
  AdminAccountResponseSchema,
  AdminConfirmationResponseSchema,
  AdminSessionsRevokeResponseSchema,
  CSRF_HEADER,
  type AdminConfirmationBody,
} from '@repo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_JOURNAL_KEY } from '../mock-journal';
import { MOCK_STATE_KEY, readMockState, writeMockState } from '../mock-state';
import { createMockTransport } from '../transport';

// The S9b mock routes follow the S9a contract (docs/04 «Adminlar»): ADMIN_EXISTS, OWNER_ROW,
// `allowlisted`, a deactivation ends the sessions, ending this tab's own session signs it out.

const BASE = 'http://localhost:5000/api/v1';
const transport = createMockTransport({
  apiBaseUrl: BASE,
  now: () => new Date('2026-11-24T09:00:00Z'),
});
const REASON = 'S9b mock tekshiruvi uchun sabab';
let seq = 0;

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  seq += 1;
  const response = await transport({
    method,
    url: `${BASE}${path}`,
    headers: {
      [CSRF_HEADER]: 'csrf',
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'idempotency-key': `key_s9b_${String(seq).padStart(4, '0')}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response as {
    status: number;
    body: { data?: unknown; error?: { code: string; details?: unknown } };
  };
}

async function otp(confirmation: AdminConfirmationBody) {
  const issued = await call('POST', '/admin/confirmations', confirmation);
  const { challengeId } = AdminConfirmationResponseSchema.parse(issued.body.data);
  return { challengeId, code: '123456' };
}

async function admins() {
  return AdminAccountListResponseSchema.parse((await call('GET', '/admin/admins')).body.data);
}

beforeEach(() => {
  window.sessionStorage.removeItem(MOCK_JOURNAL_KEY);
  window.sessionStorage.removeItem(MOCK_STATE_KEY);
  writeMockState({ signedIn: true, role: 'OWNER', writeScenario: 'ok' });
});

describe('mock admin management', () => {
  it('adds an admin; a new id is not allowlisted; a taken id is ADMIN_EXISTS', async () => {
    const fields = { telegramId: '5550000002', name: 'Ali V.', role: 'SUPPORT' } as const;
    const added = await call('POST', '/admin/admins', {
      ...fields,
      reason: REASON,
      otp: await otp({ action: 'admins.create', ...fields }),
    });
    expect(AdminAccountResponseSchema.parse(added.body.data).admin).toMatchObject({
      ...fields,
      allowlisted: false,
      isActive: true,
    });
    expect((await admins()).some((admin) => admin.telegramId === '5550000002')).toBe(true);
    const again = await call('POST', '/admin/admins', {
      ...fields,
      reason: REASON,
      otp: await otp({ action: 'admins.create', ...fields }),
    });
    expect(again.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { fields: [{ path: 'telegramId', code: 'ADMIN_EXISTS' }] },
    });
  });

  it('an OWNER row is OWNER_ROW; its sessions may still be ended', async () => {
    const owner = await call('PATCH', '/admin/admins/mkadm000001', {
      name: 'Boshqa',
      reason: REASON,
      otp: await otp({ action: 'admins.update', targetId: 'mkadm000001', name: 'Boshqa' }),
    });
    expect(owner.body.error).toMatchObject({
      details: { fields: [{ path: 'id', code: 'OWNER_ROW' }] },
    });
    const ended = await call('POST', '/admin/admins/mkadm000001/sessions/revoke', {
      reason: REASON,
      otp: await otp({ action: 'admins.sessionsRevoke', targetId: 'mkadm000001' }),
    });
    expect(AdminSessionsRevokeResponseSchema.parse(ended.body.data)).toMatchObject({
      revokedSessions: 2,
      currentRevoked: true,
      applied: true,
    });
    expect(readMockState().signedIn).toBe(false);
  });

  it('a deactivation ends the sessions; an unchanged PATCH writes nothing', async () => {
    const off = await call('PATCH', '/admin/admins/mkadm000002', {
      isActive: false,
      reason: REASON,
      otp: await otp({ action: 'admins.update', targetId: 'mkadm000002', isActive: false }),
    });
    expect(AdminAccountResponseSchema.parse(off.body.data).admin).toMatchObject({
      isActive: false,
      activeSessions: 0,
    });
    const same = await call('PATCH', '/admin/admins/mkadm000002', {
      isActive: false,
      reason: REASON,
      otp: await otp({ action: 'admins.update', targetId: 'mkadm000002', isActive: false }),
    });
    expect(AdminAccountResponseSchema.parse(same.body.data)).toMatchObject({
      applied: false,
      auditId: null,
    });
  });

  it('a single session of another admin is ended without signing this tab out', async () => {
    const ended = await call('POST', '/admin/sessions/mkadm000003s0/revoke', {
      reason: REASON,
      otp: await otp({ action: 'sessions.revoke', targetId: 'mkadm000003s0' }),
    });
    expect(AdminSessionsRevokeResponseSchema.parse(ended.body.data)).toMatchObject({
      revokedSessions: 1,
      currentRevoked: false,
    });
    expect(readMockState().signedIn).toBe(true);
    const malika = (await admins()).find((admin) => admin.id === 'mkadm000003');
    expect(malika?.activeSessions).toBe(0);
  });
});
