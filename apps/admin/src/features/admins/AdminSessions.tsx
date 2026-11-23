import type { AdminAccountListResponse, AdminSessionListResponse } from '@repo/shared';
import { Button, DataTable, Icon, type DataTableColumn } from '@repo/ui';
import { useQueries } from '@tanstack/react-query';
import { MonitorSmartphone, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listAdminSessions } from '../../lib/api/reads';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { Tag } from '../common/Tag';

type Row = AdminSessionListResponse[number] & { adminName: string };

/**
 * "Faol sessiyalar": the API lists sessions per admin (`/admins/:id/sessions`), so the section
 * asks only for admins that have any and merges the answers, newest use first.
 */
export function AdminSessions({ admins }: { admins: AdminAccountListResponse }) {
  const t = useTranslations();
  const withSessions = admins.filter((admin) => admin.activeSessions > 0);
  const results = useQueries({
    queries: withSessions.map((admin) => ({
      queryKey: qk.admins.sessions(admin.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAdminSessions(admin.id, signal),
    })),
  });
  const failed = results.find((result) => result.isError);
  const pending = results.some((result) => result.isPending);
  const retrying = results.some((result) => result.isFetching);
  const retryFailed = () =>
    results.forEach((result) => {
      if (result.isError) void result.refetch();
    });
  const rows: Row[] = results
    .flatMap((result, index) =>
      (result.data ?? [])
        .filter((session) => session.revokedAt === null)
        .map((session) => ({ ...session, adminName: withSessions[index]?.name ?? '' })),
    )
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  // M-4: rows already shown stay shown while others load or are retried (no skeleton flash); the
  // skeleton only covers an empty table, and an error only shows once nothing is pending.
  const state = rows.length > 0 ? 'data' : pending ? 'loading' : failed ? 'error' : 'empty';
  const partial = failed !== undefined && !pending && rows.length > 0;
  const columns: DataTableColumn<Row>[] = [
    {
      id: 'admin',
      header: t('admin.admins.col.admin'),
      cell: (row) => (
        <span className="flex items-center gap-1.5 font-extrabold">
          {row.adminName}
          {row.current ? <Tag tone="ok">{t('admin.admins.thisSession')}</Tag> : null}
        </span>
      ),
    },
    { id: 'agent', header: t('admin.sessions.col.device'), cell: (row) => row.userAgent ?? '—' },
    {
      id: 'ip',
      header: t('admin.list.col.ip'),
      cell: (row) => row.ipMasked ?? '—',
      className: 'font-mono text-[11px]',
    },
    {
      id: 'used',
      header: t('admin.admins.col.lastUsed'),
      cell: (row) => formatDateTime(row.lastUsedAt),
    },
    {
      id: 'expires',
      header: t('admin.sessions.col.expires'),
      cell: (row) => formatDateTime(row.expiresAt),
      className: 'text-foreground-secondary',
    },
  ];
  return (
    <section aria-labelledby="admin-sessions" className="flex flex-col gap-2">
      <h2 id="admin-sessions" className="m-0 text-sm leading-[18px] font-extrabold">
        {t('admin.admins.sessionsTitle')}
      </h2>
      {partial ? (
        // Some admins' sessions came back, others failed (R-7): the list is incomplete, say so.
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-xs leading-4 font-bold text-warning-text"
        >
          <Icon icon={TriangleAlert} size={14} />
          <span className="min-w-0 flex-1">{t('admin.admins.sessionsPartial')}</span>
          <Button variant="outline" size="sm" loading={retrying} onClick={retryFailed}>
            {t('admin.states.retry')}
          </Button>
        </div>
      ) : null}
      <DataTable
        label={t('admin.admins.sessionsTitle')}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        state={state}
        minWidth={760}
        skeletonRows={3}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={MonitorSmartphone} title={t('admin.admins.noSessions')} />}
        error={<LoadError error={failed?.error} onRetry={retryFailed} retrying={retrying} />}
      />
    </section>
  );
}
