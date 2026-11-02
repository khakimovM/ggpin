import type { Me } from '@repo/shared';
import type { User } from '@repo/db';

// The only place a User row becomes the public /me shape. Fields are listed one by one (no
// spread) so a new column on User can never reach the wire by accident: phone, isBlocked,
// purchaseFrozen and botBlockedAt are internal.
export function toMe(user: User): Me {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    photoUrl: user.photoUrl,
    locale: user.locale,
    referralCode: user.referralCode,
    phoneLinked: user.phone !== null,
  };
}
