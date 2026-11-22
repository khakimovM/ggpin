import { RECONCILE_MISMATCH_CODES, type AdminReconcileResponse } from '@repo/shared';
import { Skeleton } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { GitCompare } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listReconcile } from '../../lib/api/reads';
import { formatCount, formatDate, formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { Pager } from '../common/Pager';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';
import { BankMessageDrawer } from '../payments/BankMessageDrawer';
import { ReconExamples } from './ReconExamples';

type AdminReconcileDay = AdminReconcileResponse[number];

const SPEC = {} as const;

/** The mismatch codes of a day that are not zero, in the shared order. */
export function mismatchesOf(day: AdminReconcileDay) {
  return RECONCILE_MISMATCH_CODES.filter((code) => day.mismatches[code] > 0).map((code) => ({
    code,
    count: day.mismatches[code],
    examples: day.examples[code],
  }));
}

function DayCard({ day }: { day: AdminReconcileDay }) {
  const t = useTranslations();
  const found = mismatchesOf(day);
  const figures = [
    [t('admin.recon.checked'), formatCount(day.checkedMessages)],
    [t('admin.recon.debits'), formatCount(day.debits)],
    [t('admin.recon.openReviews'), formatCount(day.openReviews)],
    [t('admin.recon.historyScan'), day.historyScan],
  ] as const;
  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm leading-[18px] font-extrabold tabular-nums">
          {formatDate(`${day.day}T12:00:00+05:00`)}
        </h2>
        <Tag tone={day.ok ? 'ok' : 'bad'}>
          {day.ok ? t('admin.recon.ok') : t('admin.recon.diff', { count: found.length })}
        </Tag>
        <span className="ml-auto text-[11px] leading-[14px] font-semibold text-foreground-muted tabular-nums">
          {t('admin.recon.ranAt', { time: formatDateTime(day.createdAt) })}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {figures.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-[10px] bg-surface px-3 py-2">
            <dt className="text-[11px] leading-[14px] font-bold text-foreground-muted">{label}</dt>
            <dd className="m-0 text-sm leading-[18px] font-extrabold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {found.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {found.map((item) => (
            <li
              key={item.code}
              className="flex flex-col gap-1 rounded-[10px] border border-border bg-danger-soft/40 px-3 py-2"
            >
              <span className="flex items-center gap-2 text-xs leading-4 font-bold">
                <Tag tone="bad">{formatCount(item.count)}</Tag>
                {t(`admin.recon.code.${item.code}`)}
              </span>
              {item.examples.length > 0 ? (
                <ReconExamples code={item.code} ids={item.examples} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function Recon() {
  const t = useTranslations();
  const { page, setPage } = useListParams(SPEC);
  const query = useQuery({
    queryKey: qk.payments.reconcile({ page }),
    queryFn: ({ signal }) => listReconcile({ page, limit: 10 }, signal),
    placeholderData: keepPreviousData,
  });
  const days = query.data?.items;
  return (
    <>
      <PageHeader title={t('admin.nav.recon')} sub={t('admin.recon.sub')} />
      {days && days.length > 0 ? (
        <>
          {days.map((day) => (
            <DayCard key={day.auditId} day={day} />
          ))}
          {query.data ? (
            <div className="overflow-hidden rounded-md border border-border bg-card">
              <Pager meta={query.data.meta} onPage={setPage} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {days ? (
            <ListEmpty
              icon={GitCompare}
              title={t('admin.recon.empty')}
              description={t('admin.recon.emptyHint')}
            />
          ) : query.isError ? (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <div
              role="status"
              aria-label={t('admin.states.loading')}
              className="flex flex-col gap-3 px-3.5"
            >
              <Skeleton className="h-32 rounded-md" />
              <Skeleton className="h-32 rounded-md" />
            </div>
          )}
        </div>
      )}
      <BankMessageDrawer />
    </>
  );
}

export function ReconPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="payments.read" title={t('admin.nav.recon')}>
      <Recon />
    </SectionGate>
  );
}
