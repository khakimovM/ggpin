import { TG_USERNAME_PATTERN, type ValidateRecipientResponse } from '@repo/shared';
import type { ApiErrorCode } from '../../lib/api/errors';
import { retryDelaySec } from './retry-delay';

// The recipient form as a state machine (Product.dc.html `recipient`). Invariant 8: nothing can be
// paid for until the recipient was looked up by the server AND the visitor confirmed who it is,
// and any edit of the username throws that confirmation (and the token) away.
//
//   idle -> checking -> found -> confirmed
//             |  |  |      |        `- (the server says the token is dead) -> expired
//             |  |  |      `- (change) -> idle
//             |  |  `- down / blocked (premium)
//             |  `- notfound / invalid
//             `- (an edit at any point) -> idle
//
// `expired` is `idle` with a note: the token lives 10 minutes (docs/04) and a quote asked for with
// a dead one answers RECIPIENT_INVALID. The username stays; the visitor looks it up and confirms
// again (the person is shown again, it is never confirmed on the visitor's behalf).

export type RecipientPhase =
  | 'idle'
  | 'checking'
  | 'found'
  | 'confirmed'
  | 'notfound'
  | 'invalid'
  | 'down'
  | 'blocked'
  | 'expired';

/** What the server said about the person, shown for the visitor to confirm. */
export interface FoundRecipient {
  displayName: string;
  photoUrl: string | undefined;
  warnings: ValidateRecipientResponse['warnings'];
}

export interface RecipientState {
  phase: RecipientPhase;
  /** As typed, without the leading "@". */
  username: string;
  /** Only in `found` and `confirmed`; it lives in memory and never in storage. */
  token: string | null;
  found: FoundRecipient | null;
  /** Epoch ms before which a new check is refused (a 429 with Retry-After), else null. */
  retryAt: number | null;
}

export const INITIAL_RECIPIENT: RecipientState = {
  phase: 'idle',
  username: '',
  token: null,
  found: null,
  retryAt: null,
};

export type RecipientAction =
  | { type: 'edit'; username: string }
  | { type: 'invalid' }
  | { type: 'checking' }
  | { type: 'found'; response: ValidateRecipientResponse }
  /** `at` is the time of the answer (epoch ms), so the reducer itself stays pure. */
  | { type: 'failed'; code: ApiErrorCode; at: number; retryAfterSec?: number }
  | { type: 'confirm' }
  | { type: 'expire' }
  | { type: 'reset' };

/** "@aziz_k " -> "aziz_k". The field also strips what it cannot hold; this covers a paste. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

export function isValidUsername(username: string): boolean {
  return TG_USERNAME_PATTERN.test(username);
}

/**
 * The phase an error of `/recipients/validate` leads to. Codes that say something about the
 * person map to their own phase; everything else (the check is down, rate limited, offline, an
 * inactive product) is "could not check", which the visitor can simply retry.
 */
export function phaseForFailure(code: ApiErrorCode): RecipientPhase {
  switch (code) {
    case 'RECIPIENT_NOT_FOUND':
      return 'notfound';
    case 'RECIPIENT_INVALID':
    case 'VALIDATION_ERROR':
      return 'invalid';
    case 'RECIPIENT_HAS_PREMIUM':
      // A blocking 422 (docs/04 Q-A): no token was issued, so there is nothing to confirm.
      return 'blocked';
    default:
      return 'down';
  }
}

export function recipientReducer(state: RecipientState, action: RecipientAction): RecipientState {
  switch (action.type) {
    case 'edit': {
      const username = normalizeUsername(action.username);
      // Typing the same text again keeps what was learned about it.
      if (username === state.username) return state;
      return { ...INITIAL_RECIPIENT, username };
    }
    case 'invalid':
      return { ...state, phase: 'invalid', token: null, found: null };
    case 'checking':
      return { ...state, phase: 'checking', token: null, found: null, retryAt: null };
    case 'found': {
      // An answer only matters to the check that is waiting for it.
      if (state.phase !== 'checking') return state;
      const { recipientToken, displayName, photoUrl, warnings } = action.response;
      return {
        ...state,
        phase: 'found',
        token: recipientToken,
        found: { displayName, photoUrl, warnings },
      };
    }
    case 'failed': {
      if (state.phase !== 'checking') return state;
      const retryAt =
        action.code === 'RATE_LIMITED'
          ? action.at + retryDelaySec(action.retryAfterSec) * 1000
          : null;
      return {
        ...state,
        phase: phaseForFailure(action.code),
        token: null,
        found: null,
        retryAt,
      };
    }
    case 'confirm':
      // Only a recipient the server returned can be confirmed.
      if (state.phase !== 'found' || state.token === null) return state;
      return { ...state, phase: 'confirmed' };
    case 'expire':
      // Only a confirmation can expire; a visitor who already edited has nothing to lose.
      if (state.phase !== 'confirmed') return state;
      return { ...INITIAL_RECIPIENT, phase: 'expired', username: state.username };
    case 'reset':
      return { ...INITIAL_RECIPIENT, username: state.username };
  }
}
