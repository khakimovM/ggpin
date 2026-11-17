import { ErrorState, Skeleton } from '@repo/ui';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';
import { useAdminSession } from '../features/auth/use-admin-session';
import { isApiError } from '../lib/api/errors';
import { AdminContext } from './admin-context';

/** The shell's frame while `GET /admin/auth/me` is in flight: sidebar rail and header outlines. */
function ShellSkeleton() {
  const t = useTranslations();
  return (
    <div
      role="status"
      aria-label={t('admin.states.loading')}
      className="grid min-h-dvh grid-cols-[64px_minmax(0,1fr)] bg-background lg:grid-cols-[248px_minmax(0,1fr)]"
    >
      <div className="border-r border-border bg-surface" />
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

/**
 * Gate of every signed-in page. Not signed in (me answered 404) -> the login page, remembering
 * where the admin was going. A network or server failure is not a sign-out: it offers a retry.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const location = useLocation();
  const session = useAdminSession();

  if (session.isPending) return <ShellSkeleton />;
  if (session.isError) {
    const network = isApiError(session.error) && session.error.code === 'NETWORK';
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-4">
        <ErrorState
          title={t('admin.states.loadFailed')}
          description={network ? t('admin.states.network') : undefined}
          retryLabel={t('admin.states.retry')}
          retrying={session.isFetching}
          onRetry={() => void session.refetch()}
          className="w-full max-w-[440px]"
        />
      </main>
    );
  }
  if (session.data === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <AdminContext.Provider value={session.data}>{children}</AdminContext.Provider>;
}
