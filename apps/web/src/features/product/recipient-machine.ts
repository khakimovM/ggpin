import { normalizeTgUsername, type ValidateRecipientResponse } from '@repo/shared';
import type { ApiErrorCode } from '../../lib/api/errors';
import { retryDelaySec } from './retry-delay';

// The recipient form as a state machine (Product.dc.html `recipient`). Invariant 8: nothing can be
// paid for until the recipient was looked up by the server AND the visitor confirmed who it is,
// and any edit of the username throws that confirmation (and the token) away.
//
//   idle -> checking -> found -> confirmed
//             |  |  |      |        `- (the server says the token is dead) -> expired
//             |  |  |      `- (change) -> idle
//             |  |  `- down / busy (429) / blocked (premium)
//             |  `- notfound / invalid
//             `- (an edit at any point) -> idle
//
// `expired` is `idle` with a note: the token lives 10 minutes (docs/04) and a quote asked for with
// a dead one answers RECIPIENT_INVALID. The username stays; the visitor looks it up and confirms
// again (the person is shown again, it is never confirmed on the visitor's behalf).
//
// "An edit" means another person: `Aziz_K` and `aziz_k` are one Telegram user (the shared
// canonical form), so changing one into the other keeps the check, the token and the confirmation.

export type RecipientPhase =
  | 'idle'
  | 'checking'
  | 'found'
  | 'confirmed'
  | 'notfound'
  | 'invalid'
  | 'down'
  | 'busy'
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
  /**
   * Exactly as typed, so the field never changes under the visitor's cursor. What is sent, shown
   * on the cards and ordered is `canonicalUsername` of it, derived (never stored twice, so the
   * two can never drift apart).
   */
  username: string;
  /** Only in `found` and `confirmed`; it lives in memory and never in storage. */
  token: string | null;
  found: FoundRecipient | null;
  /** Epoch ms before which a new check is refused (`busy`: a 429 with Retry-After), else null. */
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
  /** `username`: the canonical name the answer is about; an answer about anyone else is ignored. */
  | { type: 'found'; username: string; response: ValidateRecipientResponse }
  /** `at` is the time of the answer (epoch ms), so the reducer itself stays pure. */
  | { type: 'failed'; username: string; code: ApiErrorCode; at: number; retryAfterSec?: number }
  | { type: 'confirm' }
  | { type: 'expire' }
  | { type: 'reset' };

/**
 * The one canonical form, the server's own (shared `normalizeTgUsername`: spaces and one leading
 * "@" dropped, lower-cased), or null when it is not a username. The page keeps no rule of its own.
 */
export function canonicalUsername(typed: string): string | null {
  return normalizeTgUsername(typed);
}

/** Both name the same Telegram user (`Aziz_K`, ` @aziz_k`): going from one to the other is no edit. */
export function sameRecipient(a: string, b: string): boolean {
  const canonical = canonicalUsername(a);
  return canonical !== null && canonical === canonicalUsername(b);
}

/**
 * The phase an error of `/recipients/validate` leads to. Codes that say something about the
 * person map to their own phase. A 429 is `busy`: this visitor's previous check is still running
 * on the server, or too many were asked; the visitor waits for Retry-After and retries. Everything
 * else (the check is down, offline, an inactive product) is "could not check", retried at once.
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
    case 'RATE_LIMITED':
      return 'busy';
    default:
      return 'down';
  }
}

// Depth behind the hook's generation guard: even an answer that slipped through cannot land on a
// different person than the one in the field.
function answersCurrent(state: RecipientState, username: string): boolean {
  return state.phase === 'checking' && canonicalUsername(state.username) === username;
}

export function recipientReducer(state: RecipientState, action: RecipientAction): RecipientState {
  switch (action.type) {
    case 'edit': {
      if (action.username === state.username) return state;
      // The same person in another spelling keeps what was learned about them; the field still
      // shows exactly what was typed.
      if (sameRecipient(action.username, state.username)) {
        return { ...state, username: action.username };
      }
      return { ...INITIAL_RECIPIENT, username: action.username };
    }
    case 'invalid':
      return { ...state, phase: 'invalid', token: null, found: null };
    case 'checking':
      return { ...state, phase: 'checking', token: null, found: null, retryAt: null };
    case 'found': {
      // An answer only matters to the check that is waiting for it, about the person typed now.
      if (!answersCurrent(state, action.username)) return state;
      const { recipientToken, displayName, photoUrl, warnings } = action.response;
      return {
        ...state,
        phase: 'found',
        token: recipientToken,
        found: { displayName, photoUrl, warnings },
      };
    }
    case 'failed': {
      if (!answersCurrent(state, action.username)) return state;
      const phase = phaseForFailure(action.code);
      // Only `busy` waits: the server named when it will take a check again.
      const retryAt =
        phase === 'busy' ? action.at + retryDelaySec(action.retryAfterSec) * 1000 : null;
      return {
        ...state,
        phase,
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
