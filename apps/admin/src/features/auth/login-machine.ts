import { OTP_CODE_TTL_SEC, type AdminLoginStatusResponse } from '@repo/shared';
import { isApiError } from '../../lib/api/errors';

// The admin login as a pure state machine (Login.dc.html `variant: admin`, docs/04 "Admin" Auth):
//   start -> starting -> waiting -> code (-> wrong) -> success
//                                \-> expired | rejected, and error banners on start / code.
// The flow of the web login (D-27) with the `admin_` payload; nothing here touches the network,
// the clock or the DOM.

/** Status polling: every 2 s, and no longer than the nonce lives (10 minutes). */
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_AFTER_SEC = 60;

export type LoginProblem =
  { kind: 'rateLimited'; until: number } | { kind: 'network' } | { kind: 'generic' };

export type LoginPhase =
  | { name: 'start'; problem: LoginProblem | null }
  | { name: 'starting' }
  | { name: 'waiting'; nonce: string; botUrl: string }
  | {
      name: 'code';
      nonce: string;
      botUrl: string;
      /** Epoch ms after which the code can no longer be accepted. */
      deadline: number;
      verifying: boolean;
      /** Set after CODE_INVALID; `shake` changes on every failed attempt. */
      wrong: { attemptsLeft: number; shake: number } | null;
      problem: LoginProblem | null;
    }
  | { name: 'expired' }
  | { name: 'rejected' }
  | { name: 'success' };

export type LoginEvent =
  | { type: 'START' }
  | { type: 'STARTED'; nonce: string; botUrl: string }
  | { type: 'START_FAILED'; problem: LoginProblem }
  | { type: 'RESET' }
  | { type: 'STATUS'; status: AdminLoginStatusResponse['status']; now: number }
  | { type: 'POLL_TIMEOUT' }
  | { type: 'TTL_ELAPSED' }
  | { type: 'CODE_EDITED' }
  | { type: 'VERIFY_START' }
  | { type: 'VERIFY_WRONG'; attemptsLeft: number }
  | { type: 'VERIFY_EXPIRED' }
  | { type: 'VERIFY_FAILED'; problem: LoginProblem }
  | { type: 'VERIFY_OK' };

export const INITIAL_PHASE: LoginPhase = { name: 'start', problem: null };

export function loginReducer(phase: LoginPhase, event: LoginEvent): LoginPhase {
  switch (event.type) {
    case 'START':
      // From the code step this is "Yangi kod olish": the login begins again with a new nonce.
      if (phase.name === 'code') return phase.verifying ? phase : { name: 'starting' };
      return phase.name === 'start' || phase.name === 'expired' || phase.name === 'rejected'
        ? { name: 'starting' }
        : phase;
    case 'STARTED':
      return phase.name === 'starting'
        ? { name: 'waiting', nonce: event.nonce, botUrl: event.botUrl }
        : phase;
    case 'START_FAILED':
      return phase.name === 'starting' ? { name: 'start', problem: event.problem } : phase;
    case 'RESET':
      return INITIAL_PHASE;
    case 'STATUS':
      return onStatus(phase, event);
    case 'POLL_TIMEOUT':
      return phase.name === 'waiting' ? { name: 'expired' } : phase;
    case 'TTL_ELAPSED':
    case 'VERIFY_EXPIRED':
      return phase.name === 'code' ? { name: 'expired' } : phase;
    case 'CODE_EDITED': {
      if (phase.name !== 'code') return phase;
      // A rate limit is the server's wait: editing the boxes must not bypass Retry-After.
      const problem = phase.problem?.kind === 'rateLimited' ? phase.problem : null;
      return phase.wrong === null && phase.problem === problem
        ? phase
        : { ...phase, wrong: null, problem };
    }
    case 'VERIFY_START':
      return phase.name === 'code' ? { ...phase, verifying: true, problem: null } : phase;
    case 'VERIFY_WRONG':
      if (phase.name !== 'code') return phase;
      if (event.attemptsLeft <= 0) return { name: 'expired' };
      return {
        ...phase,
        verifying: false,
        wrong: { attemptsLeft: event.attemptsLeft, shake: (phase.wrong?.shake ?? 0) + 1 },
      };
    case 'VERIFY_FAILED':
      return phase.name === 'code' ? { ...phase, verifying: false, problem: event.problem } : phase;
    case 'VERIFY_OK':
      return phase.name === 'code' ? { name: 'success' } : phase;
  }
}

function onStatus(phase: LoginPhase, event: Extract<LoginEvent, { type: 'STATUS' }>): LoginPhase {
  if (phase.name !== 'waiting') return phase;
  switch (event.status) {
    case 'PENDING':
      return phase;
    case 'CODE_SENT':
      return {
        name: 'code',
        nonce: phase.nonce,
        botUrl: phase.botUrl,
        deadline: event.now + OTP_CODE_TTL_SEC * 1000,
        verifying: false,
        wrong: null,
        problem: null,
      };
    case 'DENIED':
      return { name: 'rejected' };
    case 'EXPIRED':
      return { name: 'expired' };
  }
}

/** Reduces whatever a login request threw to the few cases the screen tells apart. */
export function problemOf(error: unknown, now: number): LoginProblem {
  if (!isApiError(error)) return { kind: 'generic' };
  if (error.code === 'RATE_LIMITED') {
    return {
      kind: 'rateLimited',
      until: now + (error.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC) * 1000,
    };
  }
  return error.code === 'NETWORK' ? { kind: 'network' } : { kind: 'generic' };
}

/** `@bot` from the start answer's `t.me/<bot>?start=admin_…` link (already schema-checked). */
export function botHandleOf(botUrl: string): string {
  try {
    return `@${new URL(botUrl).pathname.slice(1)}`;
  } catch {
    return '';
  }
}
