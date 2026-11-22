import { ADMIN_USER_STATUS_FILTERS, type AdminUserRow } from '@repo/shared';
import { DataTable, type DataTableColumn } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { listUsers } from '../../lib/api/people';
import { DATE_PRESETS, fromOfPreset } from '../../lib/date-range';
import { formatCount, formatDate, formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { ClearFilters } from '../common/ClearFilters';
import { FilterPills } from '../common/FilterPills';
import { ROW_LINK } from '../common/link-style';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { PageHeader } from '../common/PageHeader';
import { Pager } from '../common/Pager';
import { SearchField } from '../common/SearchField';
import { SectionGate } from '../common/SectionGate';
import { SelectFilter } from '../common/SelectFilter';
import { tableState } from '../common/table-state';
import { Tag } from '../common/Tag';
import { Toolbar } from '../common/Toolbar';
import { USER_STATUS_TONE, userStatus } from './user-status';
import { camelKey } from '../../lib/camel-key';

const SPEC = {
  status: { default: 'all', values: ['all', ...ADMIN_USER_STATUS_FILTERS] },
  q: { default: '', maxLength: 64 },
  joined: { default: 'all', values: DATE_PRESETS },
} as const;

function Users_() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { values, page, set, setPage, reset } = useListParams(SPEC);
  const params = {
    status: values.status === 'all' ? undefined : values.status,
    q: values.q || undefined,
    from: fromOfPreset(values.joined, new Date()),
    page,
  };
  const query = useQuery({
    queryKey: qk.users.list({ ...params, joined: values.joined, from: undefined }),
    queryFn: ({ signal }) => listUsers(params, signal),
    placeholderData: keepPreviousData,
  });
  const columns: DataTableColumn<AdminUserRow>[] = [
    {
      id: 'tg',
      header: t('admin.users.col.telegramId'),
      cell: (user) => (
        <Link to={`/users/${user.id}`} className={ROW_LINK}>
          {user.telegramId}
        </Link>
      ),
    },
    {
      id: 'username',
      header: t('admin.users.col.username'),
      cell: (user) => (user.username ? `@${user.username}` : '—'),
    },
    {
      id: 'locale',
      header: t('admin.users.col.locale'),
      cell: (user) => user.locale.toUpperCase(),
    },
    {
      id: 'created',
      header: t('admin.users.col.created'),
      cell: (user) => formatDate(user.createdAt),
    },
    {
      id: 'seen',
      header: t('admin.users.col.lastSeen'),
      cell: (user) => (user.lastSeenAt ? formatDateTime(user.lastSeenAt) : '—'),
      className: 'text-foreground-secondary',
    },
    {
      id: 'balance',
      header: t('admin.users.col.balance'),
      align: 'end',
      cell: (user) => <MoneyCell tiyin={user.balanceTiyin} />,
    },
    {
      id: 'orders',
      header: t('admin.users.col.orders'),
      align: 'end',
      cell: (user) => formatCount(user.ordersCount),
    },
    {
      id: 'refs',
      header: t('admin.users.col.referrals'),
      align: 'end',
      cell: (user) => formatCount(user.referralsCount),
    },
    {
      id: 'status',
      header: t('admin.users.col.status'),
      cell: (user) => {
        const status = userStatus(user);
        return (
          <Tag tone={USER_STATUS_TONE[status]}>{t(`admin.users.status.${camelKey(status)}`)}</Tag>
        );
      },
    },
  ];
  const state = tableState(query, query.data?.items.length);
  return (
    <>
      <PageHeader
        title={t('admin.nav.users')}
        sub={
          query.data
            ? t('admin.users.total', { total: formatCount(query.data.meta.total) })
            : undefined
        }
      />
      <Toolbar>
        <FilterPills
          label={t('admin.users.col.status')}
          value={values.status}
          onChange={(status) => set({ status })}
          options={SPEC.status.values.map((value) => ({
            value,
            label: t(value === 'all' ? 'admin.list.all' : `admin.users.status.${camelKey(value)}`),
          }))}
        />
        <SelectFilter
          label={t('admin.users.joined')}
          value={values.joined}
          onChange={(joined) => set({ joined })}
          options={DATE_PRESETS.map((value) => ({ value, label: t(`admin.list.date.${value}`) }))}
        />
        <span className="ml-auto max-sm:w-full">
          <SearchField
            label={t('admin.users.search')}
            placeholder={t('admin.users.searchPlaceholder')}
            value={values.q}
            onChange={(q) => set({ q })}
          />
        </span>
      </Toolbar>
      <DataTable
        label={t('admin.nav.users')}
        columns={columns}
        rows={query.data?.items ?? []}
        rowKey={(user) => user.id}
        state={state}
        minWidth={980}
        loadingLabel={t('admin.states.loading')}
        onRowClick={(user) => void navigate(`/users/${user.id}`)}
        empty={
          <ListEmpty
            icon={Users}
            title={t('admin.users.emptyList')}
            description={t('admin.list.emptyFiltered')}
            action={<ClearFilters onClear={reset} />}
          />
        }
        error={
          <LoadError
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        }
        footer={query.data ? <Pager meta={query.data.meta} onPage={setPage} /> : null}
      />
    </>
  );
}

export function UsersPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="users.read" title={t('admin.nav.users')}>
      <Users_ />
    </SectionGate>
  );
}
