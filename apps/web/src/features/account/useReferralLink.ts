'use client';

import { env } from '../../env';
import { useMe } from '../auth/use-me';
import { referralLink } from './referral-link';

export type ReferralLinkState =
  /** `/me` is loading. */
  | { status: 'pending' }
  /** `/me` could not be read: a retry may help. */
  | { status: 'error'; retry: () => void; retrying: boolean }
  /** `/me` came, but its code or the bot username in env does not make a link: a retry will not help. */
  | { status: 'invalid' }
  | { status: 'ready'; link: string };

/** The signed-in user's Mini App invitation link, and why there is none when there is none. */
export function useReferralLink(): ReferralLinkState {
  const me = useMe();
  if (me.data === undefined) {
    return me.isError
      ? { status: 'error', retry: () => void me.refetch(), retrying: me.isFetching }
      : { status: 'pending' };
  }
  const link = referralLink(env.NEXT_PUBLIC_BOT_USERNAME, me.data.referralCode, 'miniApp');
  return link === null ? { status: 'invalid' } : { status: 'ready', link };
}
