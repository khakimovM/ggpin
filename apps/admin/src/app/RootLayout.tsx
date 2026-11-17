import { BRAND } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { onSessionLost } from '../lib/api/client';
import { isPrivateQuery, qk } from '../lib/query-keys';

/** Router state the login page reads: `ended` = the session ran out while the panel was open. */
export interface LoginLocationState {
  from?: string;
  ended?: boolean;
}

/**
 * The top of the route tree: the document title, and the reaction to a lost session. Any admin
 * request whose 404 turns out to mean "no session" (lib/api/http.ts) lands here: the cached data
 * is dropped and the admin is sent to the login page with a "session ended" note.
 */
export function RootLayout() {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    document.title = `${BRAND.name} · ${t('admin.shell.title')}`;
  }, [t]);

  useEffect(
    () =>
      onSessionLost(() => {
        // Only a session that existed can "end"; the first me request of a signed-out browser
        // also answers 404 and must lead to a plain login page.
        const hadSession = Boolean(queryClient.getQueryData(qk.auth.me()));
        queryClient.removeQueries({ predicate: (query) => isPrivateQuery(query.queryKey) });
        queryClient.setQueryData(qk.auth.me(), null);
        if (hadSession && window.location.pathname !== '/login') {
          const state: LoginLocationState = { ended: true, from: window.location.pathname };
          void navigate('/login', { replace: true, state });
        }
      }),
    [navigate, queryClient],
  );

  return <Outlet />;
}
