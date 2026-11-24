import type { AdminReviewQueueResponse } from '@repo/shared';
import { Skeleton } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { enumKey } from '../../lib/enum-text';
import { listReviewQueue } from '../../lib/api/people';
import { formatCost, formatCount } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MockNote } from '../common/MockNote';
import { MoneyCell } from '../common/MoneyCell';
import { OrderStatusTag } from '../common/OrderStatusTag';
import { PageHeader } from '../common/PageHeader';
import { Pager } from '../common/Pager';
import { PendingActions } from '../common/PendingActions';
import { SectionGate } from '../common/SectionGate';
import { TEXT_LINK } from '../common/link-style';

type Entry = AdminReviewQueueResponse[number];

const SPEC = { status: { default: 'all', values: ['all', 'NEEDS_REVIEW', 'HELD'] } } as const;

function ReviewCard({ order }: { order: Entry }) {
  const t = useTranslations();
  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm leading-[18px] font-extrabold tabular-nums">
          #{order.number} · {[order.product.name, order.sku?.label].filter(Boolean).join(' · ')}
        </h2>
        <OrderStatusTag status={order.status} />
        <span className="ml-auto text-[11px] leading-[14px] font-semibold text-foreground-muted tabular-nums">
          {t('admin.review.age', { minutes: formatCount(Math.floor(order.ageSec / 60)) })}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          [
            t('admin.orders.col.user'),
            order.user.username ? `@${order.user.username}` : order.user.id,
          ],
          [t('admin.orders.col.recipient'), order.recipient.displayName ?? '—'],
          [t('admin.orders.col.cost'), formatCost(order.costCurrency, order.costMinor)],
          [
            t('admin.review.reason'),
            order.statusReason === null ? '—' : t(enumKey('orderReason', order.statusReason)),
          ],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-surface px-3 py-2"
          >
            <dt className="text-[11px] leading-[14px] font-bold text-foreground-muted">{label}</dt>
            <dd className="m-0 truncate text-xs leading-4 font-extrabold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] leading-[18px] font-extrabold">
          <MoneyCell tiyin={order.totalTiyin} />
        </span>
        <PendingActions labels={[t('admin.review.retry'), t('admin.review.refund')]} />
        <Link to={`/orders/${order.id}`} className={`ml-auto text-xs ${TEXT_LINK}`}>
          {t('admin.review.open')} →
        </Link>
      </div>
    </article>
  );
}

function ReviewQueue() {
  const t = useTranslations();
  const { values, page, set, setPage } = useListParams(SPEC);
  const params = { status: values.status === 'all' ? undefined : values.status, page };
  const query = useQuery({
    queryKey: qk.orders.reviewQueue(params),
    queryFn: ({ signal }) => listReviewQueue(params, signal),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items;
  return (
    <>
      <PageHeader
        title={t('admin.nav.review')}
        sub={
          query.data
            ? t('admin.review.total', { count: formatCount(query.data.meta.total) })
            : undefined
        }
      />
      <MockNote />
      <FilterPills
        label={t('admin.orders.col.status')}
        value={values.status}
        onChange={(status) => set({ status })}
        options={SPEC.status.values.map((value) => ({
          value,
          label: value === 'all' ? t('admin.list.all') : t(enumKey('orderStatus', value)),
        }))}
      />
      {items && items.length > 0 ? (
        <>
          {items.map((order) => (
            <ReviewCard key={order.id} order={order} />
          ))}
          {query.data ? (
            <div className="overflow-hidden rounded-md border border-border bg-card">
              <Pager meta={query.data.meta} onPage={setPage} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {items ? (
            <ListEmpty
              icon={ClipboardCheck}
              title={t('admin.review.empty')}
              description={t('admin.review.emptyHint')}
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
              <Skeleton className="h-36 rounded-md" />
              <Skeleton className="h-36 rounded-md" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function ReviewQueuePage() {
  const t = useTranslations();
  return (
    <SectionGate permission="orders.read" title={t('admin.nav.review')}>
      <ReviewQueue />
    </SectionGate>
  );
}
