import type { AdminAccount, AdminAccountListResponse } from '@repo/shared';
import { Avatar, Button, DataTable, FOCUS_RING, Icon, cn, type DataTableColumn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, TriangleAlert, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { RoleBadge } from '../../app/shell/RoleBadge';
import { listAdmins } from '../../lib/api/reads';
import { formatCount, formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { SectionGate } from '../common/SectionGate';
import { tableState } from '../common/table-state';
import { Tag } from '../common/Tag';
import { useAdminAction } from '../common/use-admin-action';
import { AddAdminDialog } from './AddAdminDialog';
import { AdminRowActions } from './AdminRowActions';
import { AdminSessions } from './AdminSessions';

type Account = AdminAccountListResponse[number];

/** The env list devops edits (docs/04 «Adminlar»): a name in code, not text to translate. */
const ALLOWLIST_ENV = 'ADMIN_TELEGRAM_IDS';

/** After an add whose Telegram id is not in `ADMIN_TELEGRAM_IDS` yet: who must do what (two keys). */
function NotAllowlisted({ admin, onClose }: { admin: AdminAccount; onClose: () => void }) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5 text-xs leading-4 font-bold text-warning-text"
    >
      <Icon icon={TriangleAlert} size={15} className="mt-px flex-none" />
      <span className="min-w-0 flex-1">
        {t('admin.admins.dialog.add.notAllowlisted', {
          name: admin.name,
          telegramId: admin.telegramId,
        })}{' '}
        <code className="font-mono">{ALLOWLIST_ENV}</code>
      </span>
      <button
        type="button"
        aria-label={t('admin.dialogs.close')}
        onClick={onClose}
        className={cn(
          'grid size-6 flex-none place-items-center rounded-[6px] hover:opacity-75',
          FOCUS_RING,
        )}
      >
        <Icon icon={X} size={14} />
      </button>
    </div>
  );
}

function Admins() {
  const t = useTranslations();
  const act = useAdminAction();
  const [adding, setAdding] = useState(false);
  const [unlisted, setUnlisted] = useState<AdminAccount | null>(null);
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
    {
      id: 'actions',
      // The sr-only text is absolute: a relative wrapper keeps it inside the table's scroll box.
      header: (
        <span className="relative">
          <span className="sr-only">{t('admin.list.actions')}</span>
        </span>
      ),
      align: 'end',
      cell: (row) => <AdminRowActions admin={row} />,
    },
  ];
  return (
    <>
      <PageHeader
        title={t('admin.nav.admins')}
        actions={
          act.can('admins.create') ? (
            <Button type="button" size="sm" onClick={() => setAdding(true)}>
              <Icon icon={UserPlus} size={14} />
              {t('admin.admins.add')}
            </Button>
          ) : null
        }
      />
      {unlisted === null ? null : (
        <NotAllowlisted admin={unlisted} onClose={() => setUnlisted(null)} />
      )}
      <DataTable
        label={t('admin.nav.admins')}
        columns={columns}
        rows={query.data ?? []}
        rowKey={(row) => row.id}
        state={tableState(query, query.data?.length)}
        minWidth={1080}
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
      <AddAdminDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(admin) => setUnlisted(admin.allowlisted ? null : admin)}
      />
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
