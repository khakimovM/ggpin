import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { gateForError, SESSION_GATE_CODES } from '../gate-for-error';

const error = (code: ConstructorParameters<typeof ApiError>[0]['code'], status = 400) =>
  new ApiError({ status, code });

describe('gateForError', () => {
  it.each([
    ['USER_BLOCKED', 'blocked'],
    ['INITDATA_EXPIRED', 'reopen'],
    ['INITDATA_INVALID', 'reopen'],
    ['NETWORK', 'offline'],
    ['RATE_LIMITED', 'error'],
    ['INTERNAL_ERROR', 'error'],
  ] as const)('%s -> %s', (code, kind) => {
    expect(gateForError(error(code)).kind).toBe(kind);
  });

  it('keeps the server message key for the generic gate', () => {
    expect(gateForError(error('RATE_LIMITED', 429)).messageKey).toBe('errors.RATE_LIMITED');
  });

  it('treats a non-API failure as a generic one', () => {
    expect(gateForError(new TypeError('boom'))).toEqual({
      kind: 'error',
      messageKey: 'common.error.network',
    });
  });

  it('only the three final codes end a session in the middle of a visit', () => {
    expect([...SESSION_GATE_CODES].sort()).toEqual([
      'INITDATA_EXPIRED',
      'INITDATA_INVALID',
      'USER_BLOCKED',
    ]);
  });
});
