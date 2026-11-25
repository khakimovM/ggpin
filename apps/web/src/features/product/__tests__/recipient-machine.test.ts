import type { ValidateRecipientResponse } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalUsername,
  INITIAL_RECIPIENT,
  phaseForFailure,
  recipientReducer,
  sameRecipient,
  type RecipientAction,
  type RecipientState,
} from '../recipient-machine';
import { retryDelaySec } from '../retry-delay';

const TOKEN = 'a'.repeat(43);
const RESPONSE: ValidateRecipientResponse = {
  recipientToken: TOKEN,
  displayName: 'Aziz',
  warnings: [],
};

const run = (actions: RecipientAction[], from: RecipientState = INITIAL_RECIPIENT) =>
  actions.reduce(recipientReducer, from);

const checking = () => run([{ type: 'edit', username: 'aziz_k' }, { type: 'checking' }]);
const found = () => run([{ type: 'found', username: 'aziz_k', response: RESPONSE }], checking());
const confirmed = () => run([{ type: 'confirm' }], found());

describe('username: the shared canonical form', () => {
  it('drops the spaces and ONE @, and lower-cases (the server does the same)', () => {
    expect(canonicalUsername(' @Aziz_K ')).toBe('aziz_k');
    expect(canonicalUsername('AZIZ_K')).toBe('aziz_k');
  });

  it('follows the Telegram format: 5-32 characters, starts with a letter; else null', () => {
    expect(canonicalUsername('aziz_k')).toBe('aziz_k');
    expect(canonicalUsername('@@aziz')).toBeNull();
    expect(canonicalUsername('dk')).toBeNull();
    expect(canonicalUsername('1azizk')).toBeNull();
    expect(canonicalUsername('a'.repeat(33))).toBeNull();
    expect(canonicalUsername('aziz-k')).toBeNull();
  });

  it('two spellings of one user are the same recipient; nothing invalid is', () => {
    expect(sameRecipient('Aziz_K', ' @aziz_k')).toBe(true);
    expect(sameRecipient('aziz_k', 'aziz_kk')).toBe(false);
    expect(sameRecipient('dk', 'dk')).toBe(false);
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
    ['RATE_LIMITED', 'busy'],
    ['PRODUCT_UNAVAILABLE', 'down'],
    ['INTERNAL_ERROR', 'down'],
    ['NETWORK', 'down'],
  ];
  it.each(cases)('%s -> %s, and no token', (code, phase) => {
    const next = run([{ type: 'failed', username: 'aziz_k', code, at: 0 }], checking());
    expect(next.phase).toBe(phase);
    expect(next.token).toBeNull();
    expect(next.found).toBeNull();
  });

  it('keeps the typed username so it can be corrected', () => {
    expect(
      run([{ type: 'failed', username: 'aziz_k', code: 'RECIPIENT_NOT_FOUND', at: 0 }], checking())
        .username,
    ).toBe('aziz_k');
  });
});

describe('invariant 8: nothing is confirmed without the server', () => {
  it('a confirm without a found recipient does nothing', () => {
    expect(run([{ type: 'confirm' }], checking()).phase).toBe('checking');
    expect(run([{ type: 'confirm' }]).phase).toBe('idle');
  });

  it('an answer that arrives when no check is waiting is ignored', () => {
    const edited = run([{ type: 'edit', username: 'someone_else' }], found());
    expect(run([{ type: 'found', username: 'aziz_k', response: RESPONSE }], edited)).toBe(edited);
    expect(
      run([{ type: 'failed', username: 'aziz_k', code: 'RECIPIENT_NOT_FOUND', at: 0 }], edited),
    ).toBe(edited);
  });

  it('while checking, an answer about another name than the one in the field is ignored', () => {
    const waiting = checking();
    expect(run([{ type: 'found', username: 'someone_else', response: RESPONSE }], waiting)).toBe(
      waiting,
    );
    expect(
      run(
        [{ type: 'failed', username: 'someone_else', code: 'RECIPIENT_NOT_FOUND', at: 0 }],
        waiting,
      ),
    ).toBe(waiting);
  });

  it('editing the username drops the confirmation and the token', () => {
    const next = run([{ type: 'edit', username: 'aziz_kk' }], confirmed());
    expect(next).toMatchObject({ phase: 'idle', username: 'aziz_kk', token: null, found: null });
  });

  it('typing the same text again keeps the confirmation', () => {
    const before = confirmed();
    expect(run([{ type: 'edit', username: 'aziz_k' }], before)).toBe(before);
  });

  it('Aziz_K -> aziz_k is not an edit: same person, same token; the field keeps the typing', () => {
    const before = run([
      { type: 'edit', username: 'Aziz_K' },
      { type: 'checking' },
      { type: 'found', username: 'aziz_k', response: RESPONSE },
      { type: 'confirm' },
    ]);
    const next = run([{ type: 'edit', username: 'aziz_k' }], before);
    expect(next).toMatchObject({ phase: 'confirmed', token: TOKEN, username: 'aziz_k' });
    expect(next.found).toEqual(before.found);
  });

  it('an edit to an invalid spelling is an edit (nothing to compare with)', () => {
    expect(run([{ type: 'edit', username: '@@aziz_k' }], confirmed())).toMatchObject({
      phase: 'idle',
      token: null,
    });
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
      run(
        [{ type: 'checking' }, { type: 'found', username: 'aziz_k', response: RESPONSE }],
        expired,
      ),
    ).toMatchObject({
      phase: 'found',
      token: TOKEN,
    });
  });

  it('a 429 remembers when the next check is allowed; other failures do not', () => {
    const limited = run(
      [{ type: 'failed', username: 'aziz_k', code: 'RATE_LIMITED', at: 1_000, retryAfterSec: 7 }],
      checking(),
    );
    expect(limited).toMatchObject({ phase: 'busy', retryAt: 8_000 });
    expect(
      run([{ type: 'failed', username: 'aziz_k', code: 'NETWORK', at: 1_000 }], checking()).retryAt,
    ).toBeNull();
    expect(run([{ type: 'checking' }], limited).retryAt).toBeNull();
  });
});

describe('busy (429 RATE_LIMITED)', () => {
  it('Retry-After missing or not a number: the default wait; out of range: clamped', () => {
    const at = 10_000;
    // No header, or one that is not a number: the default of retryDelaySec (5 s).
    for (const retryAfterSec of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = run(
        [{ type: 'failed', username: 'aziz_k', code: 'RATE_LIMITED', at, retryAfterSec }],
        checking(),
      );
      expect(next).toMatchObject({ phase: 'busy', retryAt: at + retryDelaySec(undefined) * 1000 });
      expect(next.retryAt).toBe(15_000);
    }
    // A number outside 1..60 s is clamped, never zero (no instant retry loop) and never a day.
    const clamp = (retryAfterSec: number) =>
      run(
        [{ type: 'failed', username: 'aziz_k', code: 'RATE_LIMITED', at, retryAfterSec }],
        checking(),
      ).retryAt;
    expect(clamp(0)).toBe(11_000);
    expect(clamp(-3)).toBe(11_000);
    expect(clamp(3600)).toBe(70_000);
  });

  it('an edit after busy goes back to idle and forgets the wait', () => {
    const busy = run(
      [{ type: 'failed', username: 'aziz_k', code: 'RATE_LIMITED', at: 0, retryAfterSec: 9 }],
      checking(),
    );
    expect(run([{ type: 'edit', username: 'other_user' }], busy)).toEqual({
      ...INITIAL_RECIPIENT,
      username: 'other_user',
    });
  });
});
