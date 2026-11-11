'use client';

import { Button, EmptyState, ErrorState, Icon, Skeleton } from '@repo/ui';
import { CircleAlert, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRevokeOtherSessions, useRevokeSession, useSessions } from '../auth/use-sessions';
import { EndOtherSessions } from './EndOtherSessions';
import { SessionRow } from './SessionRow';

function RowsSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="flex items-center gap-3 border-t border-border py-3 first:border-t-0"
        >
          <Skeleton className="size-10 flex-none rounded-control" />
          <span className="flex flex-1 flex-col gap-2">
            <Skeleton shape="text" className="w-36" />
            <Skeleton shape="text" className="w-24" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Store.dc.html profile "Faol sessiyalar": the devices signed in to this account. */
export function SessionsList() {
  const t = useTranslations('web.sessions');
  const common = useTranslations('common');
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const endAll = useRevokeOtherSessions();
  const busy = revoke.isPending || endAll.isPending;
  const otherIds = sessions.data?.filter((session) => !session.current).map((s) => s.id) ?? [];

  let body;
  if (sessions.isPending) {
    body = <RowsSkeleton />;
  } else if (sessions.isError) {
    body = (
      <ErrorState
        framed={false}
        title={t('loadError')}
        retryLabel={common('retry')}
        retrying={sessions.isFetching}
        onRetry={() => void sessions.refetch()}
      />
    );
  } else if (sessions.data.length === 0) {
    body = (
      <EmptyState
        framed={false}
        icon={<Icon icon={Monitor} size={24} />}
        title={t('empty')}
        action={
          <Button variant="outline" onClick={() => void sessions.refetch()}>
            {common('retry')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <ul className="m-0 flex list-none flex-col p-0">
        {sessions.data.map((session, index) => (
          <SessionRow
            key={session.id}
            session={session}
            first={index === 0}
            revoking={revoke.isPending && revoke.variables === session.id}
            busy={busy}
            onRevoke={(id) => revoke.mutate(id)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-[22px]">
      <h2 className="m-0 text-lg leading-6 font-extrabold">{t('title')}</h2>
      {body}
      {otherIds.length === 0 ? null : (
        <EndOtherSessions
          running={endAll.isPending}
          disabled={busy}
          failed={endAll.isError}
          onEnd={() => endAll.mutate(otherIds)}
        />
      )}
      {revoke.isError ? (
        <p
          role="alert"
          className="m-0 flex items-center gap-2 text-[13px] leading-[18px] font-bold text-danger-text"
        >
          <Icon icon={CircleAlert} size={15} />
          {t('revokeError')}
        </p>
      ) : null}
    </section>
  );
}
