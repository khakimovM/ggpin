import type { AdminWriteKeyVoidBody, AdminWriteKeyVoidResponse } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import {
  adminActionId,
  beginAttempt,
  markActionOutcomeUnknown,
  pendingAction,
  type AdminActionId,
} from '../idempotency';
import { expectedAuditId, resolveActionOutcome } from '../idempotency-outcome';
import { voidAnswer } from '../../test/void-answer';

const ADMIN = 'cmadminowner01';
let seq = 0;

afterEach(() => {
  window.sessionStorage.clear();
});

/** An action whose attempt (key) ended with an unknown outcome. */
function unknownAction(kind: 'users.block' | 'admins.create' = 'users.block'): {
  action: AdminActionId;
  key: string;
} {
  seq += 1;
  const action = adminActionId(ADMIN, kind, `void_${seq}`);
  const { key, attempt } = beginAttempt(action);
  markActionOutcomeUnknown(action, key, { reason: 'Sabab matni', conflict: false, attempt });
  return { action, key };
}

/** The API's answer for the key it was asked about (its own audit row id, SA L-1). */
const answer =
  (status: 'APPLIED' | 'VOIDED') =>
  (body: AdminWriteKeyVoidBody): Promise<AdminWriteKeyVoidResponse> =>
    voidAnswer(ADMIN, body, status);

describe('expectedAuditId', () => {
  it('matches the golden vector of the API test (admin-write-key.spec.ts, Q1 = A)', async () => {
    await expect(expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0001')).resolves.toBe(
      'a4a27d4c0f956eb31c1081662e576705',
    );
  });

  it('depends on both the admin and the key', async () => {
    const base = await expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0001');
    expect(await expectedAuditId('cmadmin0golden0vector00002', 'golden-key_0001')).not.toBe(base);
    expect(await expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0002')).not.toBe(base);
  });
});

describe('resolveActionOutcome (the key void, 9-B Q2 = A)', () => {
  it('sends the key, the kind and the registry target; APPLIED settles the entry', async () => {
    const { action, key } = unknownAction();
    const send = vi.fn(answer('APPLIED'));
    const result = await resolveActionOutcome(action, send);
    expect(send).toHaveBeenCalledWith({
      idempotencyKey: key,
      action: 'users.block',
      targetId: `void_${seq}`,
    });
    expect(result).toEqual({
      kind: 'applied',
      auditId: await expectedAuditId(ADMIN, key),
      action: 'USER_BLOCK',
    });
    expect(pendingAction(action)).toBeNull();
  });

  it('VOIDED gives a new key at once, the flags cleared', async () => {
    const { action, key } = unknownAction();
    const result = await resolveActionOutcome(action, answer('VOIDED'));
    expect(result.kind).toBe('voided');
    const next = pendingAction(action);
    expect(next?.key).not.toBe(key);
    expect(result).toEqual({ kind: 'voided', key: next?.key });
    expect(next).toMatchObject({ unknown: false, conflict: false });
  });

  it('never voids while an attempt of the key is out (N-1)', async () => {
    const { action, key } = unknownAction();
    beginAttempt(action);
    const send = vi.fn(answer('VOIDED'));
    await expect(resolveActionOutcome(action, send)).resolves.toEqual({ kind: 'out' });
    expect(send).not.toHaveBeenCalled();
    expect(pendingAction(action)?.key).toBe(key);
  });

  it.each([
    [
      '404 (role, session or CSRF)',
      new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true }),
    ],
    [
      '503 ADMIN_DEADLINE_EXCEEDED',
      new ApiError({ status: 503, code: 'ADMIN_DEADLINE_EXCEEDED', fromServer: true }),
    ],
    ['no answer or the 30 s timeout', new ApiError({ status: 0, code: 'NETWORK' })],
    ['429', new ApiError({ status: 429, code: 'RATE_LIMITED', fromServer: true })],
    ['a bad answer shape', new Error('schema')],
  ])('%s is no verdict: the key and its flags stay', async (_name, error) => {
    const { action, key } = unknownAction();
    const result = await resolveActionOutcome(action, () => Promise.reject(error));
    expect(result).toEqual({ kind: 'failed' });
    expect(pendingAction(action)).toMatchObject({ key, unknown: true });
  });

  it('a VOIDED that arrives while an attempt of the key went out replaces nothing (N-1)', async () => {
    const { action } = unknownAction();
    const result = await resolveActionOutcome(action, (body) => {
      // Meanwhile an attempt with the same key left: it will come back 409, not be replaced.
      beginAttempt(action);
      return answer('VOIDED')(body);
    });
    expect(result).toEqual({ kind: 'failed' });
  });

  it.each(['APPLIED', 'VOIDED'] as const)(
    '%s naming the audit row of another key is no verdict: the key and its flags stay (SA L-1)',
    async (status) => {
      const { action, key } = unknownAction();
      const other = await voidAnswer(
        ADMIN,
        { idempotencyKey: 'some-other-key_01', action: 'users.block', targetId: 'x' },
        status,
      );
      const result = await resolveActionOutcome(action, () => Promise.resolve(other));
      expect(result).toEqual({ kind: 'failed' });
      expect(pendingAction(action)).toMatchObject({ key, unknown: true });
    },
  );

  it('the same audit id from another admin is no verdict either (SA L-1)', async () => {
    const { action, key } = unknownAction();
    const result = await resolveActionOutcome(action, (body) =>
      voidAnswer('cmadminother001', body, 'VOIDED'),
    );
    expect(result).toEqual({ kind: 'failed' });
    expect(pendingAction(action)?.key).toBe(key);
  });

  it('an add voids with the stored Telegram ID, not the registry target', async () => {
    seq += 1;
    const action = adminActionId(ADMIN, 'admins.create', 'new');
    const { key, attempt } = beginAttempt(action, '5550000003');
    markActionOutcomeUnknown(action, key, { reason: 'Sabab matni', conflict: false, attempt });
    const send = vi.fn(answer('VOIDED'));
    await resolveActionOutcome(action, send);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      action: 'admins.create',
      targetId: '5550000003',
    });
  });
});
