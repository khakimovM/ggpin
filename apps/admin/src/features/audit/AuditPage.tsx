import { ADMIN_AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, type AdminAuditRow } from '@repo/shared';
import { DataTable, FOCUS_RING, cn, type DataTableColumn } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { enumKey } from '../../lib/enum-text';
import { useAdmin } from '../../app/admin-context';
import { listAudit } from '../../lib/api/people';
import { DATE_PRESETS, fromOfPreset } from '../../lib/date-range';
import { useDrawerParam } from '../../lib/drawer-param';
import { formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { ClearFilters } from '../common/ClearFilters';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { Pager } from '../common/Pager';
import { SectionGate } from '../common/SectionGate';
import { SelectFilter } from '../common/SelectFilter';
import { tableState } from '../common/table-state';
import { Tag } from '../common/Tag';
import { Toolbar } from '../common/Toolbar';
import { AuditDrawer } from './AuditDrawer';
import { AuditExportButton } from './AuditExportButton';

const SPEC = {
  actor: { default: 'all', values: ['all', ...AUDIT_ACTOR_TYPES] },
  action: { default: 'all', values: ['all', ...ADMIN_AUDIT_ACTIONS] },
  date: { default: 'all', values: DATE_PRESETS },
} as const;

function Audit() {
  const t = useTranslations();
  const me = useAdmin();
  const drawer = useDrawerParam('entry');
  const { values, page, set, setPage, reset } = useListParams(SPEC);
  const filters = {
    actorType: values.actor === 'all' ? undefined : values.actor,
    action: values.action === 'all' ? undefined : values.action,
    from: fromOfPreset(values.date, new Date()),
  };
  const query = useQuery({
    queryKey: qk.audit.list({ ...filters, from: values.date, page }),
    queryFn: ({ signal }) => listAudit({ ...filters, page }, signal),
    placeholderData: keepPreviousData,
  });
  const columns: DataTableColumn<AdminAuditRow>[] = [
    {
      id: 'time',
      header: t('admin.audit.col.time'),
      cell: (row) => (
        <button
          type="button"
          onClick={() => drawer.open(row.id)}
          className={cn('rounded-xs font-extrabold whitespace-nowrap hover:underline', FOCUS_RING)}
        >
          {formatDateTime(row.createdAt)}
        </button>
      ),
    },
    {
      id: 'actor',
      header: t('admin.audit.col.actor'),
      cell: (row) => row.actor.name ?? t(`admin.audit.actor.${row.actor.type}`),
    },
    {
      id: 'action',
      header: t('admin.audit.col.action'),
      cell: (row) => <Tag tone="info">{t(enumKey('auditAction', row.action))}</Tag>,
    },
    {
      id: 'target',
      header: t('admin.audit.col.target'),
      cell: (row) => `${row.targetType} · ${row.targetId}`,
      className: 'font-mono text-[11px] text-foreground-secondary',
    },
    {
      id: 'reason',
      header: t('admin.audit.col.reason'),
      cell: (row) => <span className="line-clamp-1 max-w-64">{row.reason ?? '—'}</span>,
    },
    {
      id: 'ip',
      header: t('admin.list.col.ip'),
      cell: (row) => row.ip ?? '—',
      className: 'font-mono text-[11px]',
    },
  ];
  const rows = query.data?.items;
  return (
    <>
      <PageHeader
        title={t('admin.nav.audit')}
        sub={t('admin.audit.sub')}
        actions={
          me.permissions.includes('audit.export') ? <AuditExportButton filters={filters} /> : null
        }
      />
      <Toolbar>
        <FilterPills
          label={t('admin.audit.col.actor')}
          value={values.actor}
          onChange={(actor) => set({ actor })}
          options={SPEC.actor.values.map((value) => ({
            value,
            label: value === 'all' ? t('admin.list.all') : t(`admin.audit.actor.${value}`),
          }))}
        />
        <SelectFilter
          label={t('admin.audit.col.action')}
          value={values.action}
          onChange={(action) => set({ action })}
          options={SPEC.action.values.map((value) => ({
            value,
            label: value === 'all' ? t('admin.list.all') : t(enumKey('auditAction', value)),
          }))}
        />
        <SelectFilter
          label={t('admin.list.date.label')}
          value={values.date}
          onChange={(date) => set({ date })}
          options={DATE_PRESETS.map((value) => ({ value, label: t(`admin.list.date.${value}`) }))}
        />
      </Toolbar>
      <DataTable
        label={t('admin.nav.audit')}
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        state={tableState(query, rows?.length)}
        minWidth={960}
        onRowClick={(row) => drawer.open(row.id)}
        loadingLabel={t('admin.states.loading')}
        empty={
          <ListEmpty
            icon={ScrollText}
            title={t('admin.audit.empty')}
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
      <AuditDrawer
        open={drawer.id !== null}
        entry={rows?.find((row) => row.id === drawer.id)}
        loading={rows === undefined && !query.isError}
        loadFailed={query.isError && rows === undefined}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        onClose={drawer.close}
      />
    </>
  );
}

export function AuditPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="audit.read" title={t('admin.nav.audit')}>
      <Audit />
    </SectionGate>
  );
}
