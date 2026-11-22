import type { AdminUserRow } from '@repo/shared';
import type { TagTone } from '../common/Tag';

export type UserStatus = 'ACTIVE' | 'BLOCKED' | 'FROZEN' | 'BOT_BLOCKED';

/** One status per user, the strongest restriction first (as the API's `status` filter reads it). */
export function userStatus(
  user: Pick<AdminUserRow, 'isBlocked' | 'purchaseFrozen' | 'botBlocked'>,
): UserStatus {
  if (user.isBlocked) return 'BLOCKED';
  if (user.purchaseFrozen) return 'FROZEN';
  if (user.botBlocked) return 'BOT_BLOCKED';
  return 'ACTIVE';
}

export const USER_STATUS_TONE: Record<UserStatus, TagTone> = {
  ACTIVE: 'ok',
  FROZEN: 'info',
  BLOCKED: 'bad',
  BOT_BLOCKED: 'mute',
};
