import { OTP_CODE_TTL_SEC, type LoginStatusResponse } from '@repo/shared';

// The web login as a pure state machine (docs/08 and Login.dc.html `state`):
//   start -> starting -> waiting -> code (-> wrong) -> success
//                                \-> expired | rejected, and error banners on start / code.
// Nothing here touches the network, the clock or the DOM, so every transition is unit-tested.

/** Status polling: every 2 s, and no longer than the nonce lives (10 minutes). */
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_MS = 10 * 60 * 1000;

/** Why a step failed; the view maps it to text. `until` is an epoch ms. */
export type LoginProblem =
  | { kind: 'rateLimited'; until: number }
  | { kind: 'blocked' }
  | { kind: 'network' }
  | { kind: 'generic' };

export type LoginPhase =
  | { name: 'start'; problem: LoginProblem | null }
  | { name: 'starting' }
  | { name: 'waiting'; nonce: string; botUrl: string }
  | {
      name: 'code';
      nonce: string;
      /** Epoch ms after which the code can no longer be accepted. */
      deadline: number;
      verifying: boolean;
      /** Set after CODE_INVALID; `shake` changes on every failed attempt so the animation replays. */
      wrong: { attemptsLeft: number; shake: number } | null;
      /** A failure that is not a wrong code (rate limit, network): the code stays, retry is ok. */
      problem: LoginProblem | null;
    }
  | { name: 'expired' }
  | { name: 'rejected' }
  | { name: 'success'; displayName: string | null };

export type LoginEvent =
  | { type: 'START' }
  | { type: 'STARTED'; nonce: string; botUrl: string }
  | { type: 'START_FAILED'; problem: LoginProblem }
  | { type: 'RESET' }
  | { type: 'STATUS'; status: LoginStatusResponse['status']; now: number }
  | { type: 'POLL_TIMEOUT' }
  | { type: 'TTL_ELAPSED' }
  | { type: 'CODE_EDITED' }
  | { type: 'VERIFY_START' }
  | { type: 'VERIFY_WRONG'; attemptsLeft: number }
  | { type: 'VERIFY_EXPIRED' }
  | { type: 'VERIFY_FAILED'; problem: LoginProblem }
  | { type: 'VERIFY_OK'; displayName: string | null };

export const INITIAL_PHASE: LoginPhase = { name: 'start', problem: null };

export function loginReducer(phase: LoginPhase, event: LoginEvent): LoginPhase {
  switch (event.type) {
    case 'START':
      // A second tap while a request is out (or a stray one mid-login) starts nothing. From the
      // code step it is "Yangi kod olish": the login begins again with a new nonce.
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
      return phase.name === 'code' ? { name: 'expired' } : phase;
    case 'CODE_EDITED': {
      if (phase.name !== 'code') return phase;
      // A rate limit is the server's wait, not a typing mistake: editing the boxes must not
      // bypass Retry-After (the view and `submit` hold the code back until `until`).
      const problem = phase.problem?.kind === 'rateLimited' ? phase.problem : null;
      return phase.wrong === null && phase.problem === problem
        ? phase
        : { ...phase, wrong: null, problem };
    }
    case 'VERIFY_START':
      return phase.name === 'code' ? { ...phase, verifying: true, problem: null } : phase;
    case 'VERIFY_WRONG':
      if (phase.name !== 'code') return phase;
      // No attempts left: the server refuses this code from now on, so ask for a new one.
      if (event.attemptsLeft <= 0) return { name: 'expired' };
      return {
        ...phase,
        verifying: false,
        wrong: { attemptsLeft: event.attemptsLeft, shake: (phase.wrong?.shake ?? 0) + 1 },
      };
    case 'VERIFY_EXPIRED':
      return phase.name === 'code' ? { name: 'expired' } : phase;
    case 'VERIFY_FAILED':
      if (phase.name !== 'code') return phase;
      // A blocked account will not get in with any code: back to the start with the reason.
      return event.problem.kind === 'blocked'
        ? { name: 'start', problem: event.problem }
        : { ...phase, verifying: false, problem: event.problem };
    case 'VERIFY_OK':
      return phase.name === 'code' ? { name: 'success', displayName: event.displayName } : phase;
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

/** The polling loop is alive only while we wait for the user to open the bot. */
export const isPolling = (phase: LoginPhase): boolean => phase.name === 'waiting';
