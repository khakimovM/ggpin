import {
  ADMIN_ROLES,
  AdminLoginStartResponseSchema,
  AdminLoginStatusResponseSchema,
  AdminLoginVerifyResponseSchema,
  AdminMeResponseSchema,
  CSRF_HEADER,
  permissionsFor,
} from '@repo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { attemptsLeftOf } from '../../errors';
import { ME_PATH, createAdminHttp } from '../../http';
import { MOCK_WRONG_CODE, meFixture, verifyFixture } from '../fixtures';
import { MOCK_STATE_KEY, writeMockState } from '../mock-state';
import { createMockTransport } from '../transport';

const BASE = 'http://localhost:5000/api/v1';
const transport = createMockTransport({
  apiBaseUrl: BASE,
  now: () => new Date('2026-11-17T09:00:00Z'),
});
const http = createAdminHttp({
  baseUrl: BASE,
  transportFor: () => Promise.resolve(transport),
  onSessionLost: () => undefined,
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function startLogin() {
  return http.fetch(
    { method: 'POST', path: '/admin/auth/start', body: {}, session: 'none' },
    AdminLoginStartResponseSchema,
  );
}

const status = (nonce: string) =>
  http.fetch(
    { path: `/admin/auth/status/${nonce}`, session: 'none' },
    AdminLoginStatusResponseSchema,
  );

const verify = (nonce: string, code: string) =>
  http.fetch(
    { method: 'POST', path: '/admin/auth/verify', body: { nonce, code }, session: 'none' },
    AdminLoginVerifyResponseSchema,
  );

beforeEach(() => {
  window.sessionStorage.removeItem(MOCK_STATE_KEY);
  writeMockState({
    signedIn: false,
    role: 'OWNER',
    startFails: false,
    deny: false,
    pendingPolls: 1,
  });
});

describe('admin mock fixtures', () => {
  it('pass the shared response schemas for every role', () => {
    for (const role of ADMIN_ROLES) {
      const me = meFixture(role, new Date());
      expect(AdminMeResponseSchema.safeParse(me).success, role).toBe(true);
      expect(me.permissions).toEqual(permissionsFor(role));
      expect(AdminLoginVerifyResponseSchema.safeParse(verifyFixture(role)).success).toBe(true);
    }
  });
});

describe('admin mock transport', () => {
  it('answers a write without the CSRF header with 404, like the API', async () => {
    const response = await transport({
      method: 'POST',
      url: `${BASE}/admin/auth/start`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    const withHeader = await transport({
      method: 'POST',
      url: `${BASE}/admin/auth/start`,
      headers: { [CSRF_HEADER]: '1' },
      body: '{}',
    });
    expect(withHeader.status).toBe(200);
  });

  it('runs the whole login: start, PENDING, CODE_SENT, wrong code, verify, me, logout', async () => {
    const start = await startLogin();
    expect(start.botUrl).toBe(`https://t.me/ggpin_mock_bot?start=admin_${start.nonce}`);
    expect(await status(start.nonce)).toEqual({ status: 'PENDING' });
    expect(await status(start.nonce)).toEqual({ status: 'CODE_SENT' });

    expect(attemptsLeftOf(await caught(verify(start.nonce, MOCK_WRONG_CODE)))).toBe(4);
    expect(await caught(http.fetch({ path: ME_PATH }, AdminMeResponseSchema))).toMatchObject({
      status: 404,
    });

    await verify(start.nonce, '123456');
    const me = await http.fetch({ path: ME_PATH }, AdminMeResponseSchema);
    expect(me.admin.role).toBe('OWNER');

    await http.fetch({ method: 'POST', path: '/admin/auth/logout', body: {} }, z.object({}));
    expect(await caught(http.fetch({ path: ME_PATH }, AdminMeResponseSchema))).toMatchObject({
      status: 404,
    });
  });

  it('ends the login after the last wrong attempt and refuses an unknown nonce', async () => {
    const { nonce } = await startLogin();
    for (let attempt = 0; attempt < 4; attempt += 1) await caught(verify(nonce, MOCK_WRONG_CODE));
    expect(await caught(verify(nonce, MOCK_WRONG_CODE))).toMatchObject({ code: 'CODE_EXPIRED' });
    expect(await caught(status('x'.repeat(43)))).toMatchObject({ status: 404 });
  });

  it('can be told to refuse the login or fail at start (e2e states)', async () => {
    writeMockState({ deny: true, pendingPolls: 0 });
    const { nonce } = await startLogin();
    expect(await status(nonce)).toEqual({ status: 'DENIED' });
    writeMockState({ startFails: true });
    expect(await caught(startLogin())).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('issues a step-up challenge only to a signed-in admin', async () => {
    const body = { action: 'sessions.revoke', targetId: 'sess1' };
    expect(
      await caught(http.fetch({ method: 'POST', path: '/admin/confirmations', body }, z.unknown())),
    ).toMatchObject({ status: 404 });
    writeMockState({ signedIn: true });
    const challenge = await http.fetch(
      { method: 'POST', path: '/admin/confirmations', body },
      z.object({ challengeId: z.string().regex(/^[0-9a-f]{32}$/), expiresInSec: z.literal(180) }),
    );
    expect(challenge.challengeId).toHaveLength(32);
  });
});
