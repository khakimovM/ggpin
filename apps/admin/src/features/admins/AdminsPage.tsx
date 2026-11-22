import type { AdminAccountListResponse } from '@repo/shared';
import { Avatar, DataTable, type DataTableColumn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { RoleBadge } from '../../app/shell/RoleBadge';
import { listAdmins } from '../../lib/api/reads';
import { formatCount, formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { PendingActions } from '../common/PendingActions';
import { SectionGate } from '../common/SectionGate';
import { tableState } from '../common/table-state';
import { Tag } from '../common/Tag';
import { AdminSessions } from './AdminSessions';

type Account = AdminAccountListResponse[number];

function Admins() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.admins.list(),
    queryFn: ({ signal }) => listAdmins(signal),
  });
  const columns: DataTableColumn<Account>[] = [
    {
      id: 'admin',
      header: t('admin.admins.col.admin'),
      cell: (row) => (
        <span className="flex items-center gap-2">
          <Avatar name={row.name} size={24} />
          <span className="font-extrabold">{row.name}</span>
        </span>
      ),
    },
    { id: 'tg', header: t('admin.users.col.telegramId'), cell: (row) => row.telegramId },
    {
      id: 'role',
      header: t('admin.admins.col.role'),
      cell: (row) => <RoleBadge role={row.role} />,
    },
    {
      id: 'state',
      header: t('admin.admins.col.state'),
      cell: (row) => (
        <span className="flex gap-1">
          <Tag tone={row.isActive ? 'ok' : 'mute'}>
            {t(row.isActive ? 'admin.admins.active' : 'admin.admins.inactive')}
          </Tag>
          {row.allowlisted ? null : <Tag tone="bad">{t('admin.admins.notAllowlisted')}</Tag>}
        </span>
      ),
    },
    {
      id: 'login',
      header: t('admin.admins.col.lastLogin'),
      cell: (row) => (row.lastLoginAt ? formatDateTime(row.lastLoginAt) : '—'),
      className: 'text-foreground-secondary',
    },
    {
      id: 'sessions',
      header: t('admin.admins.col.sessions'),
      align: 'end',
      cell: (row) => formatCount(row.activeSessions),
    },
  ];
  return (
    <>
      <PageHeader
        title={t('admin.nav.admins')}
        actions={<PendingActions labels={[t('admin.admins.add')]} />}
      />
      <DataTable
        label={t('admin.nav.admins')}
        columns={columns}
        rows={query.data ?? []}
        rowKey={(row) => row.id}
        state={tableState(query, query.data?.length)}
        minWidth={820}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={ShieldCheck} title={t('admin.admins.empty')} />}
        error={
          <LoadError
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        }
      />
      {query.data ? <AdminSessions admins={query.data} /> : null}
    </>
  );
}

export function AdminsPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="admins.read" title={t('admin.nav.admins')}>
      <Admins />
    </SectionGate>
  );
}
