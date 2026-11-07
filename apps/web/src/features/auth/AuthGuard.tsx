'use client';

import { Button, ErrorState, Skeleton } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { loginPath } from '../../i18n/paths';
import { isApiError, type ApiError } from '../../lib/api/errors';
import { loginRedirectTarget } from '../../lib/api/login-redirect';
import { useAuthUiStore } from '../../stores/auth-ui-store';
import { LogoutNotice } from './LogoutNotice';
import { useLogout } from './use-logout';
import { useMe } from './use-me';

// Rendering is client-only: the cookie session is invisible to the Next server (the API sets the
// cookies for its own host), so a store page cannot be gated on the server. Nothing private is
// rendered before `/me` has answered; the pages below fetch their own data behind this gate.

const SESSION_ENDED_CODES: ReadonlySet<string> = new Set(['UNAUTHORIZED', 'TOKEN_REUSE_DETECTED']);

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-[440px] place-items-center px-4 py-8">
      <div className="flex w-full flex-col items-center gap-4 text-center">{children}</div>
    </main>
  );
}

/** Sign-out of this tab is running or failed: say that, never "session ended". */
function LogoutScreen({ status }: { status: 'pending' | 'failed' }) {
  const t = useTranslations('web.logout');
  const logout = useLogout();
  return (
    <Centered>
      {status === 'failed' ? (
        <LogoutNotice retrying={logout.isPending} onRetry={() => logout.mutate()} />
      ) : (
        <Button variant="outline" loading>
          {t('pending')}
        </Button>
      )}
    </Centered>
  );
}

function SessionEnded({ error }: { error: ApiError }) {
  const t = useTranslations('web.auth');
  const errors = useTranslations('errors');
  const locale = useLocale();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // Where the visitor was is where the login sends them back to (`safeNextPath` checks it there).
  const href =
    loginRedirectTarget(pathname, search === '' ? '' : `?${search}`) ?? loginPath(locale);
  const blocked = error.code === 'USER_BLOCKED';
  return (
    <Centered>
      <h1 className="m-0 text-xl leading-7 font-extrabold">{t('ended.title')}</h1>
      <p className="m-0 text-sm leading-5 font-medium text-foreground-secondary">
        {blocked ? errors('USER_BLOCKED') : t('ended.hint')}
      </p>
      {blocked ? null : (
        <Button asChild size="lg" glow className="w-full">
          <a href={href}>{t('signIn')}</a>
        </Button>
      )}
    </Centered>
  );
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const t = useTranslations('web.auth');
  const common = useTranslations('common');
  const all = useTranslations();
  const logoutStatus = useAuthUiStore((state) => state.logout);
  const me = useMe();

  if (logoutStatus !== 'idle') return <LogoutScreen status={logoutStatus} />;

  if (me.isPending) {
    return (
      <Centered>
        <div aria-busy="true" className="flex w-full flex-col items-center gap-3">
          <Skeleton shape="circle" className="size-14" />
          <Skeleton shape="text" className="h-3 w-40" />
          <span className="sr-only" role="status">
            {t('checking')}
          </span>
        </div>
      </Centered>
    );
  }

  if (me.isError) {
    const error = me.error;
    if (
      isApiError(error) &&
      (SESSION_ENDED_CODES.has(error.code) || error.code === 'USER_BLOCKED')
    ) {
      return <SessionEnded error={error} />;
    }
    return (
      <Centered>
        <ErrorState
          title={isApiError(error) ? all(error.messageKey) : common('error.network')}
          retryLabel={common('retry')}
          retrying={me.isFetching}
          onRetry={() => void me.refetch()}
        />
      </Centered>
    );
  }

  return <>{children}</>;
}
