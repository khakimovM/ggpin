import { OTP_CODE_TTL_SEC } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_PHASE,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  isPolling,
  loginReducer,
  type LoginEvent,
  type LoginPhase,
} from '../login-machine';
import { botUrlIsOurs, problemOf } from '../login-problem';
import { ApiError } from '../../../lib/api/errors';

const NONCE = 'n'.repeat(43);
const BOT_URL = `https://t.me/ggpin_bot?start=login_${NONCE}`;

const run = (events: LoginEvent[], from: LoginPhase = INITIAL_PHASE): LoginPhase =>
  events.reduce(loginReducer, from);

const waiting = (): LoginPhase =>
  run([{ type: 'START' }, { type: 'STARTED', nonce: NONCE, botUrl: BOT_URL }]);

const code = (now = 1_000): LoginPhase =>
  run([{ type: 'STATUS', status: 'CODE_SENT', now }], waiting());

describe('login machine: the happy path', () => {
  it('start -> starting -> waiting -> code -> success', () => {
    expect(INITIAL_PHASE).toEqual({ name: 'start', problem: null });
    expect(run([{ type: 'START' }])).toEqual({ name: 'starting' });
    expect(waiting()).toEqual({ name: 'waiting', nonce: NONCE, botUrl: BOT_URL });
    expect(code(1_000)).toEqual({
      name: 'code',
      nonce: NONCE,
      deadline: 1_000 + OTP_CODE_TTL_SEC * 1000,
      verifying: false,
      wrong: null,
      problem: null,
    });
    const verifying = run([{ type: 'VERIFY_START' }], code());
    expect(verifying).toMatchObject({ name: 'code', verifying: true });
    expect(run([{ type: 'VERIFY_OK', displayName: 'Sardor' }], verifying)).toEqual({
      name: 'success',
      displayName: 'Sardor',
    });
  });

  it('polls only while waiting, every 2 s, for at most 10 minutes', () => {
    expect(isPolling(waiting())).toBe(true);
    for (const phase of [
      INITIAL_PHASE,
      code(),
      { name: 'expired' },
      { name: 'rejected' },
    ] as const) {
      expect(isPolling(phase)).toBe(false);
    }
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(POLL_MAX_MS).toBe(600_000);
  });
});

describe('login machine: status answers', () => {
  it('PENDING keeps waiting', () => {
    const phase = waiting();
    expect(loginReducer(phase, { type: 'STATUS', status: 'PENDING', now: 5 })).toBe(phase);
  });

  it('DENIED is a rejection and EXPIRED an expiry', () => {
    expect(run([{ type: 'STATUS', status: 'DENIED', now: 5 }], waiting())).toEqual({
      name: 'rejected',
    });
    expect(run([{ type: 'STATUS', status: 'EXPIRED', now: 5 }], waiting())).toEqual({
      name: 'expired',
    });
  });

  it('the poll timeout expires the waiting step and nothing else', () => {
    expect(run([{ type: 'POLL_TIMEOUT' }], waiting())).toEqual({ name: 'expired' });
    const inCode = code();
    expect(loginReducer(inCode, { type: 'POLL_TIMEOUT' })).toBe(inCode);
  });

  it('a late status answer cannot pull the screen out of another step', () => {
    for (const phase of [INITIAL_PHASE, code(), { name: 'rejected' }] as const) {
      expect(loginReducer(phase, { type: 'STATUS', status: 'EXPIRED', now: 5 })).toBe(phase);
    }
  });
});

describe('login machine: the code step', () => {
  it('a wrong code shows how many tries are left and replays the shake each time', () => {
    const first = run(
      [{ type: 'VERIFY_START' }, { type: 'VERIFY_WRONG', attemptsLeft: 3 }],
      code(),
    );
    expect(first).toMatchObject({ verifying: false, wrong: { attemptsLeft: 3, shake: 1 } });
    const second = run(
      [{ type: 'VERIFY_START' }, { type: 'VERIFY_WRONG', attemptsLeft: 2 }],
      first,
    );
    expect(second).toMatchObject({ wrong: { attemptsLeft: 2, shake: 2 } });
  });

  it('editing the boxes clears the wrong-code notice', () => {
    const wrong = run([{ type: 'VERIFY_WRONG', attemptsLeft: 3 }], code());
    expect(run([{ type: 'CODE_EDITED' }], wrong)).toMatchObject({ wrong: null });
  });

  it('editing the boxes does not clear a rate limit: Retry-After still applies', () => {
    const problem = { kind: 'rateLimited', until: 99_000 } as const;
    const limited = run([{ type: 'VERIFY_START' }, { type: 'VERIFY_FAILED', problem }], code());
    expect(run([{ type: 'CODE_EDITED' }], limited)).toBe(limited);
    // A wrong-code notice next to it still goes.
    const both = { ...limited, wrong: { attemptsLeft: 2, shake: 1 } } as LoginPhase;
    expect(run([{ type: 'CODE_EDITED' }], both)).toMatchObject({ wrong: null, problem });
  });

  it('no tries left, or an expired / used code, asks for a new code', () => {
    expect(run([{ type: 'VERIFY_WRONG', attemptsLeft: 0 }], code())).toEqual({ name: 'expired' });
    expect(run([{ type: 'VERIFY_EXPIRED' }], code())).toEqual({ name: 'expired' });
    expect(run([{ type: 'TTL_ELAPSED' }], code())).toEqual({ name: 'expired' });
  });

  it('a rate limit or a network failure keeps the code step and clears the spinner', () => {
    const problem = { kind: 'network' } as const;
    const phase = run([{ type: 'VERIFY_START' }, { type: 'VERIFY_FAILED', problem }], code());
    expect(phase).toMatchObject({ name: 'code', verifying: false, problem });
    expect(run([{ type: 'CODE_EDITED' }], phase)).toMatchObject({ problem: null });
  });

  it('a blocked account goes back to the start with the reason', () => {
    const problem = { kind: 'blocked' } as const;
    expect(run([{ type: 'VERIFY_FAILED', problem }], code())).toEqual({ name: 'start', problem });
  });
});

describe('login machine: restarts and stray events', () => {
  it('a failed start returns to the start step with the problem', () => {
    const problem = { kind: 'rateLimited', until: 99 } as const;
    expect(run([{ type: 'START' }, { type: 'START_FAILED', problem }])).toEqual({
      name: 'start',
      problem,
    });
  });

  it('START works from start, expired, rejected and the code step, and from nowhere else', () => {
    for (const phase of [
      INITIAL_PHASE,
      { name: 'expired' },
      { name: 'rejected' },
      code(),
    ] as const) {
      expect(loginReducer(phase, { type: 'START' })).toEqual({ name: 'starting' });
    }
    // While a code is being verified the screen is busy: no new login under it.
    const verifying = run([{ type: 'VERIFY_START' }], code());
    expect(loginReducer(verifying, { type: 'START' })).toBe(verifying);
    for (const phase of [waiting(), { name: 'starting' }] as const) {
      expect(loginReducer(phase, { type: 'START' })).toBe(phase);
    }
  });

  it('cancel and restart go back to the first step', () => {
    expect(run([{ type: 'RESET' }], waiting())).toEqual(INITIAL_PHASE);
  });

  it('a verify answer that arrives after the screen moved on is ignored', () => {
    const expired: LoginPhase = { name: 'expired' };
    expect(loginReducer(expired, { type: 'VERIFY_OK', displayName: 'x' })).toBe(expired);
    expect(loginReducer(expired, { type: 'VERIFY_WRONG', attemptsLeft: 2 })).toBe(expired);
  });
});

describe('problemOf', () => {
  it('maps RATE_LIMITED to a deadline from Retry-After (60 s without one)', () => {
    const limited = new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 });
    expect(problemOf(limited, 1_000)).toEqual({ kind: 'rateLimited', until: 31_000 });
    const bare = new ApiError({ status: 429, code: 'RATE_LIMITED' });
    expect(problemOf(bare, 1_000)).toEqual({ kind: 'rateLimited', until: 61_000 });
  });

  it('tells blocked, network and everything else apart', () => {
    expect(problemOf(new ApiError({ status: 403, code: 'USER_BLOCKED' }))).toEqual({
      kind: 'blocked',
    });
    expect(problemOf(new ApiError({ status: 0, code: 'NETWORK' }))).toEqual({ kind: 'network' });
    expect(problemOf(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }))).toEqual({
      kind: 'generic',
    });
    expect(problemOf(new Error('boom'))).toEqual({ kind: 'generic' });
  });
});

describe('botUrlIsOurs', () => {
  it('accepts a link to our bot, whatever the case', () => {
    expect(botUrlIsOurs(BOT_URL, 'ggpin_bot')).toBe(true);
    expect(botUrlIsOurs(BOT_URL, 'GGPin_Bot')).toBe(true);
  });

  it('refuses another bot, another host, another scheme and garbage', () => {
    expect(botUrlIsOurs(`https://t.me/evil_bot?start=login_${NONCE}`, 'ggpin_bot')).toBe(false);
    expect(botUrlIsOurs(`https://t.me/ggpin_bot_x?start=login_${NONCE}`, 'ggpin_bot')).toBe(false);
    expect(botUrlIsOurs(`https://telegram.me/ggpin_bot?start=login_${NONCE}`, 'ggpin_bot')).toBe(
      false,
    );
    expect(botUrlIsOurs(`http://t.me/ggpin_bot?start=login_${NONCE}`, 'ggpin_bot')).toBe(false);
    expect(botUrlIsOurs('not a url', 'ggpin_bot')).toBe(false);
  });
});
