import { LOGIN_NONCE_PATTERN } from '@repo/shared';

// Bot buttons of the admin login (callback_data, Telegram's cap is 64 bytes).
//   ad:<nonce>      "this was not me" under the code message (43-char nonce: 46 bytes)
//   ae:<sessionId>  "this was not me" under the new-login message (a cuid: well under 64)
// The session id is not a secret: the bot only acts on it for the account the session belongs
// to (AdminSessionService.endFromBot). The nonce is the same one the bot was given in /start.

const DENY_PREFIX = 'ad:';
const END_PREFIX = 'ae:';

export const ADMIN_DENY_CALLBACK = /^ad:([A-Za-z0-9_-]{43})$/;
export const ADMIN_SESSION_END_CALLBACK = /^ae:([A-Za-z0-9]{1,60})$/;

export function adminDenyCallbackData(nonce: string): string {
  if (!LOGIN_NONCE_PATTERN.test(nonce)) throw new Error('not a login nonce');
  return `${DENY_PREFIX}${nonce}`;
}

export function adminSessionEndCallbackData(sessionId: string): string {
  const data = `${END_PREFIX}${sessionId}`;
  if (!ADMIN_SESSION_END_CALLBACK.test(data)) throw new Error('not an admin session id');
  return data;
}
