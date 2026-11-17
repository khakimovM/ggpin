import { OTP_CODE_TTL_SEC } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import {
  INITIAL_PHASE,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  botHandleOf,
  loginReducer,
  problemOf,
  type LoginEvent,
  type LoginPhase,
} from '../login-machine';
import { nextPollDelayMs, verifyFailure } from '../use-login-flow';

const NONCE = 'n'.repeat(43);
const BOT_URL = `https://t.me/ggpin_bot?start=admin_${NONCE}`;

function run(events: LoginEvent[], from: LoginPhase = INITIAL_PHASE): LoginPhase {
  return events.reduce(loginReducer, from);
}

const toCode: LoginEvent[] = [
  { type: 'START' },
  { type: 'STARTED', nonce: NONCE, botUrl: BOT_URL },
  { type: 'STATUS', status: 'CODE_SENT', now: 1000 },
];

describe('admin login machine', () => {
  it('goes start -> starting -> waiting -> code with a 3-minute deadline', () => {
    expect(run([{ type: 'START' }]).name).toBe('starting');
    expect(run(toCode.slice(0, 2))).toEqual({ name: 'waiting', nonce: NONCE, botUrl: BOT_URL });
    expect(run(toCode)).toMatchObject({ name: 'code', deadline: 1000 + OTP_CODE_TTL_SEC * 1000 });
  });

  it('stays waiting on PENDING; DENIED and EXPIRED end the attempt', () => {
    const waiting = run(toCode.slice(0, 2));
    expect(loginReducer(waiting, { type: 'STATUS', status: 'PENDING', now: 1 })).toBe(waiting);
    expect(loginReducer(waiting, { type: 'STATUS', status: 'DENIED', now: 1 }).name).toBe(
      'rejected',
    );
    expect(loginReducer(waiting, { type: 'STATUS', status: 'EXPIRED', now: 1 }).name).toBe(
      'expired',
    );
    expect(loginReducer(waiting, { type: 'POLL_TIMEOUT' }).name).toBe('expired');
  });

  it('counts wrong codes and expires on the last one', () => {
    const wrong = run([
      ...toCode,
      { type: 'VERIFY_START' },
      { type: 'VERIFY_WRONG', attemptsLeft: 2 },
    ]);
    expect(wrong).toMatchObject({
      name: 'code',
      verifying: false,
      wrong: { attemptsLeft: 2, shake: 1 },
    });
    expect(loginReducer(wrong, { type: 'CODE_EDITED' })).toMatchObject({ wrong: null });
    expect(loginReducer(wrong, { type: 'VERIFY_WRONG', attemptsLeft: 0 }).name).toBe('expired');
  });

  it('keeps a rate limit when the code is edited', () => {
    const limited = run([
      ...toCode,
      { type: 'VERIFY_START' },
      { type: 'VERIFY_FAILED', problem: { kind: 'rateLimited', until: 99 } },
      { type: 'CODE_EDITED' },
    ]);
    expect(limited).toMatchObject({ problem: { kind: 'rateLimited', until: 99 } });
  });

  it('restarts from the code step ("Yangi kod olish") but not while verifying', () => {
    const code = run(toCode);
    expect(loginReducer(code, { type: 'START' }).name).toBe('starting');
    const verifying = loginReducer(code, { type: 'VERIFY_START' });
    expect(loginReducer(verifying, { type: 'START' })).toBe(verifying);
  });

  it('ignores answers that arrive in the wrong phase', () => {
    expect(loginReducer(INITIAL_PHASE, { type: 'VERIFY_OK' })).toBe(INITIAL_PHASE);
    expect(loginReducer(INITIAL_PHASE, { type: 'STARTED', nonce: NONCE, botUrl: BOT_URL })).toBe(
      INITIAL_PHASE,
    );
    expect(run([...toCode, { type: 'VERIFY_OK' }]).name).toBe('success');
  });

  it('reduces errors to the cases the screen tells apart', () => {
    expect(
      problemOf(new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 5 }), 0),
    ).toEqual({ kind: 'rateLimited', until: 5000 });
    expect(problemOf(new ApiError({ status: 0, code: 'NETWORK' }), 0)).toEqual({ kind: 'network' });
    expect(problemOf(new Error('x'), 0)).toEqual({ kind: 'generic' });
    expect(
      verifyFailure(
        new ApiError({ status: 422, code: 'CODE_INVALID', details: { attemptsLeft: 1 } }),
        0,
      ),
    ).toEqual({ type: 'VERIFY_WRONG', attemptsLeft: 1 });
    expect(verifyFailure(new ApiError({ status: 422, code: 'CODE_EXPIRED' }), 0)).toEqual({
      type: 'VERIFY_EXPIRED',
    });
  });

  it('polls every 2 s, backs off on 429, stops on an answer or after 10 minutes', () => {
    expect(nextPollDelayMs(undefined, null, 0)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs('PENDING', null, 0)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs('CODE_SENT', null, 0)).toBe(false);
    expect(nextPollDelayMs('PENDING', null, POLL_MAX_MS)).toBe(false);
    const limited = new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 });
    expect(nextPollDelayMs(undefined, limited, 0)).toBe(30_000);
  });

  it('reads the bot handle from the start link', () => {
    expect(botHandleOf(BOT_URL)).toBe('@ggpin_bot');
    expect(botHandleOf('not a url')).toBe('');
  });
});
