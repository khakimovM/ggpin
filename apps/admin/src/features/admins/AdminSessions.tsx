import type { AdminAccountListResponse, AdminSessionListResponse } from '@repo/shared';
import { Button, DataTable, FOCUS_RING, Icon, cn, type DataTableColumn } from '@repo/ui';
import { useQueries } from '@tanstack/react-query';
import { MonitorSmartphone, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { listAdminSessions } from '../../lib/api/reads';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { Tag } from '../common/Tag';
import { useAdminAction } from '../common/use-admin-action';
import { RevokeSessionsDialog } from './RevokeSessionsDialog';

type Row = AdminSessionListResponse[number] & {
  adminName: string;
  adminRole: AdminAccountListResponse[number]['role'];
};

/** «Yakunlash» of the design's session row (28px, danger text). */
function EndButton({ row, onClick }: { row: Row; onClick: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      aria-label={t('admin.admins.actions.named', {
        action: t('admin.admins.actions.revokeSession'),
        name: `${row.adminName} · ${row.userAgent ?? '—'}`,
      })}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-7 items-center rounded-[7px] border-[1.5px] border-border bg-transparent px-2.5 text-[11px] leading-none font-extrabold whitespace-nowrap text-danger-text hover:bg-danger-soft',
        FOCUS_RING,
      )}
    >
      {t('admin.admins.actions.revokeSession')}
    </button>
  );
}

/**
 * "Faol sessiyalar": the API lists sessions per admin (`/admins/:id/sessions`), so the section
 * asks only for admins that have any and merges the answers, newest use first.
 */
export function AdminSessions({ admins }: { admins: AdminAccountListResponse }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [ending, setEnding] = useState<Row | null>(null);
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
    .flatMap((result, index) => {
      // SA-I3: no guessed role (an OWNER row would lose its alert line): no admin, no rows.
      const admin = withSessions[index];
      if (admin === undefined) return [];
      return (result.data ?? [])
        .filter((session) => session.revokedAt === null)
        .map((session) => ({ ...session, adminName: admin.name, adminRole: admin.role }));
    })
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
    // Any admin's session, an OWNER's too (Q7 b); the button only by its own write permission.
    ...(act.can('sessions.revoke')
      ? [
          {
            id: 'end',
            header: (
              <span className="relative">
                <span className="sr-only">{t('admin.list.actions')}</span>
              </span>
            ),
            align: 'end' as const,
            cell: (row: Row) => <EndButton row={row} onClick={() => setEnding(row)} />,
          },
        ]
      : []),
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
        minWidth={860}
        skeletonRows={3}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={MonitorSmartphone} title={t('admin.admins.noSessions')} />}
        error={<LoadError error={failed?.error} onRetry={retryFailed} retrying={retrying} />}
      />
      {ending === null ? null : (
        <RevokeSessionsDialog
          target={{
            kind: 'session',
            sessionId: ending.id,
            adminName: ending.adminName,
            adminRole: ending.adminRole,
            device: ending.userAgent ?? '—',
            current: ending.current,
          }}
          onOpenChange={(open) => {
            if (!open) setEnding(null);
          }}
        />
      )}
    </section>
  );
}
