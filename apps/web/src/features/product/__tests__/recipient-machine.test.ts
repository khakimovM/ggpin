import type { ValidateRecipientResponse } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_RECIPIENT,
  isValidUsername,
  normalizeUsername,
  phaseForFailure,
  recipientReducer,
  type RecipientAction,
  type RecipientState,
} from '../recipient-machine';

const TOKEN = 'a'.repeat(43);
const RESPONSE: ValidateRecipientResponse = {
  recipientToken: TOKEN,
  displayName: 'Aziz',
  warnings: [],
};

const run = (actions: RecipientAction[], from: RecipientState = INITIAL_RECIPIENT) =>
  actions.reduce(recipientReducer, from);

const checking = () => run([{ type: 'edit', username: 'aziz_k' }, { type: 'checking' }]);
const found = () => run([{ type: 'found', response: RESPONSE }], checking());
const confirmed = () => run([{ type: 'confirm' }], found());

describe('username', () => {
  it('drops the @ and the spaces', () => {
    expect(normalizeUsername('  @@aziz_k ')).toBe('aziz_k');
  });

  it('follows the Telegram format: 5-32 characters, starts with a letter', () => {
    expect(isValidUsername('aziz_k')).toBe(true);
    expect(isValidUsername('dk')).toBe(false);
    expect(isValidUsername('1azizk')).toBe(false);
    expect(isValidUsername('a'.repeat(33))).toBe(false);
    expect(isValidUsername('aziz-k')).toBe(false);
  });
});

describe('the happy path', () => {
  it('idle -> checking -> found -> confirmed, with the token only once found', () => {
    expect(INITIAL_RECIPIENT.token).toBeNull();
    expect(checking().phase).toBe('checking');
    expect(checking().token).toBeNull();
    expect(found()).toMatchObject({ phase: 'found', token: TOKEN });
    expect(found().found).toEqual({ displayName: 'Aziz', photoUrl: undefined, warnings: [] });
    expect(confirmed()).toMatchObject({ phase: 'confirmed', token: TOKEN });
  });
});

describe('every error code of /recipients/validate', () => {
  const cases: Array<[Parameters<typeof phaseForFailure>[0], string]> = [
    ['RECIPIENT_NOT_FOUND', 'notfound'],
    ['RECIPIENT_INVALID', 'invalid'],
    ['VALIDATION_ERROR', 'invalid'],
    ['RECIPIENT_HAS_PREMIUM', 'blocked'],
    ['RECIPIENT_CHECK_UNAVAILABLE', 'down'],
    ['RATE_LIMITED', 'down'],
    ['PRODUCT_UNAVAILABLE', 'down'],
    ['INTERNAL_ERROR', 'down'],
    ['NETWORK', 'down'],
  ];
  it.each(cases)('%s -> %s, and no token', (code, phase) => {
    const next = run([{ type: 'failed', code, at: 0 }], checking());
    expect(next.phase).toBe(phase);
    expect(next.token).toBeNull();
    expect(next.found).toBeNull();
  });

  it('keeps the typed username so it can be corrected', () => {
    expect(run([{ type: 'failed', code: 'RECIPIENT_NOT_FOUND', at: 0 }], checking()).username).toBe(
      'aziz_k',
    );
  });
});

describe('invariant 8: nothing is confirmed without the server', () => {
  it('a confirm without a found recipient does nothing', () => {
    expect(run([{ type: 'confirm' }], checking()).phase).toBe('checking');
    expect(run([{ type: 'confirm' }]).phase).toBe('idle');
  });

  it('an answer that arrives when no check is waiting is ignored', () => {
    const edited = run([{ type: 'edit', username: 'someone_else' }], found());
    expect(run([{ type: 'found', response: RESPONSE }], edited)).toBe(edited);
    expect(run([{ type: 'failed', code: 'RECIPIENT_NOT_FOUND', at: 0 }], edited)).toBe(edited);
  });

  it('editing the username drops the confirmation and the token', () => {
    const next = run([{ type: 'edit', username: 'aziz_kk' }], confirmed());
    expect(next).toMatchObject({ phase: 'idle', username: 'aziz_kk', token: null, found: null });
  });

  it('typing the same text again keeps the confirmation', () => {
    const before = confirmed();
    expect(run([{ type: 'edit', username: '@aziz_k' }], before)).toBe(before);
  });

  it('"change" goes back to idle with the username kept and the token gone', () => {
    expect(run([{ type: 'reset' }], confirmed())).toMatchObject({
      phase: 'idle',
      username: 'aziz_k',
      token: null,
    });
  });

  it('a malformed username is "invalid" without any request step', () => {
    const next = run([{ type: 'edit', username: 'dk' }, { type: 'invalid' }]);
    expect(next).toMatchObject({ phase: 'invalid', token: null });
  });

  it('expire() turns a confirmation into "look up again", the username kept', () => {
    expect(run([{ type: 'expire' }], confirmed())).toEqual({
      ...INITIAL_RECIPIENT,
      phase: 'expired',
      username: 'aziz_k',
    });
  });

  it('expire() does nothing unless a recipient is confirmed', () => {
    for (const state of [INITIAL_RECIPIENT, checking(), found()]) {
      expect(run([{ type: 'expire' }], state)).toBe(state);
    }
  });

  it('from "expired" an edit starts over, and a new check goes the normal way', () => {
    const expired = run([{ type: 'expire' }], confirmed());
    expect(run([{ type: 'edit', username: 'other_user' }], expired)).toMatchObject({
      phase: 'idle',
      username: 'other_user',
    });
    expect(
      run([{ type: 'checking' }, { type: 'found', response: RESPONSE }], expired),
    ).toMatchObject({
      phase: 'found',
      token: TOKEN,
    });
  });

  it('a 429 remembers when the next check is allowed; other failures do not', () => {
    const limited = run(
      [{ type: 'failed', code: 'RATE_LIMITED', at: 1_000, retryAfterSec: 7 }],
      checking(),
    );
    expect(limited).toMatchObject({ phase: 'down', retryAt: 8_000 });
    expect(run([{ type: 'failed', code: 'NETWORK', at: 1_000 }], checking()).retryAt).toBeNull();
    expect(run([{ type: 'checking' }], limited).retryAt).toBeNull();
  });
});
