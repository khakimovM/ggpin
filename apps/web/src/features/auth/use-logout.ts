'use client';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { logout } from '../../lib/api/auth';
import { getActiveAuth } from '../../lib/api/client';
import { hardNavigate } from '../../lib/navigation';
import { homePath } from '../../i18n/paths';
import { useAuthUiStore } from '../../stores/auth-ui-store';

/**
 * Signs out of this device. The mutation REJECTS when the server could not be reached: the
 * cookies are still in the browser, so the UI must show "sign-out failed" with a retry, never a
 * signed-out screen. On success the page is replaced by a full navigation (not a router push):
 * every mounted component, mutation observer included, goes away with the old page.
 *
 * In the Mini App the page is reloaded at `/tg`, never at the web home: the token is gone from
 * memory, and the reloaded Mini App signs in again from the Telegram launch data. Leaving `/tg`
 * would drop the visitor into the cookie channel of the website.
 */
export function useLogout(): UseMutationResult<void, Error, void> {
  const locale = useLocale();
  const setLogout = useAuthUiStore((state) => state.setLogout);
  return useMutation({
    // A function with no parameters: the mutation variables must never reach `logout`.
    mutationFn: () => logout(),
    onMutate: () => setLogout('pending'),
    onError: () => setLogout('failed'),
    // The status stays `pending` through the navigation, so the guard does not flash "session ended".
    onSuccess: () => hardNavigate(getActiveAuth().channel === 'tg' ? '/tg' : homePath(locale)),
  });
}
