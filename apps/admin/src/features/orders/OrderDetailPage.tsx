import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, PackageX } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { getOrder } from '../../lib/api/people';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MockNote } from '../common/MockNote';
import { OrderStatusTag } from '../common/OrderStatusTag';
import { PageHeader } from '../common/PageHeader';
import { PendingActions } from '../common/PendingActions';
import { SectionGate } from '../common/SectionGate';
import { TEXT_LINK } from '../common/link-style';
import { OrderFacts } from './OrderFacts';
import { OrderHistory } from './OrderSections';

function OrderDetail({ orderId }: { orderId: string }) {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.orders.detail(orderId),
    queryFn: ({ signal }) => getOrder(orderId, signal),
  });
  const order = query.data;
  const back = (
    <Link to="/orders" className={`inline-flex items-center gap-1 self-start text-xs ${TEXT_LINK}`}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t('admin.nav.orders')}
    </Link>
  );
  if (order) {
    return (
      <>
        {back}
        <MockNote />
        <PageHeader
          title={`#${order.number} · ${[order.product.name, order.sku?.label].filter(Boolean).join(' · ')}`}
          badges={<OrderStatusTag status={order.status} />}
          sub={t('admin.orders.detail.created', { time: formatDateTime(order.createdAt) })}
        />
        <PendingActions
          labels={[
            t('admin.review.retry'),
            t('admin.orders.detail.markDelivered'),
            t('admin.review.refund'),
            t('admin.orders.detail.cancel'),
            t('admin.orders.detail.note'),
          ]}
        />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <OrderHistory order={order} />
          <OrderFacts order={order} />
        </div>
      </>
    );
  }
  return (
    <>
      {back}
      <div className="rounded-md border border-border bg-card py-6">
        {query.isError ? (
          isApiError(query.error) && query.error.code === 'NOT_FOUND' ? (
            <ListEmpty icon={PackageX} title={t('admin.orders.notFound')} />
          ) : (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          )
        ) : (
          <div
            role="status"
            aria-label={t('admin.states.loading')}
            className="flex flex-col gap-3 px-3.5"
          >
            <Skeleton className="h-10 w-72 rounded-[10px]" />
            <Skeleton className="h-72 rounded-md" />
          </div>
        )}
      </div>
    </>
  );
}

export function OrderDetailPage() {
  const t = useTranslations();
  const { id = '' } = useParams();
  return (
    <SectionGate permission="orders.read" title={t('admin.nav.orders')}>
      <OrderDetail key={id} orderId={id} />
    </SectionGate>
  );
}
