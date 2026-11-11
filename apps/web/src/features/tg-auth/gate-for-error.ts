import { isApiError, type ApiErrorMessageKey } from '../../lib/api/errors';

/**
 * - `bot`: not opened from Telegram (no initData).
 * - `blocked`: the account is blocked.
 * - `offline`: the API could not be reached.
 * - `reopen`: Telegram's launch data is expired or rejected; only reopening from the bot helps.
 * - `error`: anything else (rate limit, server error); retry is offered.
 */
export type GateKind = 'bot' | 'blocked' | 'offline' | 'reopen' | 'error';

export interface GateInfo {
  kind: GateKind;
  /** i18n key of the server's message, for the `error` gate. */
  messageKey?: ApiErrorMessageKey;
}

/** Errors that mean the session is gone for good, also when they arrive in the middle of a visit. */
export const SESSION_GATE_CODES: ReadonlySet<string> = new Set([
  'USER_BLOCKED',
  'INITDATA_EXPIRED',
  'INITDATA_INVALID',
]);

export function gateForError(error: unknown): GateInfo {
  if (!isApiError(error)) return { kind: 'error', messageKey: 'common.error.network' };
  switch (error.code) {
    case 'USER_BLOCKED':
      return { kind: 'blocked' };
    case 'INITDATA_EXPIRED':
    case 'INITDATA_INVALID':
      return { kind: 'reopen' };
    case 'NETWORK':
      return { kind: 'offline' };
    default:
      return { kind: 'error', messageKey: error.messageKey };
  }
}
