import type { LoginRequest } from '@repo/db';
import { OTP_MAX_ATTEMPTS } from '@repo/shared';
import type { LoginRequestKind } from './login-request.repository';

/** Why the bot may not hand out a code for a login link. */
export type IssueCodeFailure = 'expired' | 'alreadySent' | 'usedByOther' | 'rateLimited';

export function isLive(row: Pick<LoginRequest, 'expiresAt'>, now: Date): boolean {
  return row.expiresAt.getTime() > now.getTime();
}

/**
 * Why the login request `row` (of flow `kind`) cannot be given to `telegramId` right now;
 * null = it can be claimed. Shared by the web and the admin login so both read a row the same way.
 */
export function unclaimableReason(
  row: LoginRequest | null,
  kind: LoginRequestKind,
  telegramId: bigint,
  now: Date,
): IssueCodeFailure | null {
  if (row === null || row.kind !== kind || !isLive(row, now)) return 'expired';
  if (row.status === 'PENDING') {
    return row.telegramId === null || row.telegramId === telegramId ? null : 'usedByOther';
  }
  if (row.status === 'CODE_SENT') {
    if (row.attempts >= OTP_MAX_ATTEMPTS) return 'expired';
    return row.telegramId === telegramId ? 'alreadySent' : 'usedByOther';
  }
  return 'expired'; // USED, DENIED, EXPIRED
}

/**
 * What the polling page may learn (D-27): read-only, a request that ran out of time is EXPIRED
 * without being written, and USED is EXPIRED too, so a consumed nonce reveals nothing.
 */
export function publicLoginStatus(
  row: LoginRequest,
  now: Date,
): 'PENDING' | 'CODE_SENT' | 'DENIED' | 'EXPIRED' {
  if (row.status === 'DENIED') return 'DENIED';
  if (row.status === 'PENDING') return isLive(row, now) ? 'PENDING' : 'EXPIRED';
  if (row.status === 'CODE_SENT' && isLive(row, now) && row.attempts < OTP_MAX_ATTEMPTS) {
    return 'CODE_SENT';
  }
  return 'EXPIRED';
}
