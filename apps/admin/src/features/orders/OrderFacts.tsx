import type { AdminOrderDetailResponse } from '@repo/shared';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { formatCost } from '../../lib/format';
import { KeyValues } from '../common/KeyValues';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';
import { TEXT_LINK } from '../common/link-style';

type Order = AdminOrderDetailResponse;

/** The side cards: customer, recipient and money (price, cost, rate snapshot, profit). */
export function OrderFacts({ order }: { order: Order }) {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Panel title={t('admin.orders.detail.customer')}>
        <KeyValues
          rows={[
            {
              key: 'user',
              label: t('admin.orders.col.user'),
              value: (
                <Link to={`/users/${order.user.id}`} className={TEXT_LINK}>
                  {order.user.username ? `@${order.user.username}` : order.user.id}
                </Link>
              ),
            },
          ]}
        />
      </Panel>
      <Panel title={t('admin.orders.col.recipient')}>
        <KeyValues
          rows={[
            {
              key: 'name',
              label: t('admin.orders.detail.resolved'),
              value: order.recipient.displayName ?? '—',
            },
            ...Object.entries(order.recipient.fields).map(([key, value]) => ({
              key,
              label: key,
              value,
            })),
          ]}
        />
      </Panel>
      <Panel title={t('admin.orders.detail.money')}>
        <KeyValues
          rows={[
            {
              key: 'price',
              label: t('admin.orders.col.price'),
              value: <MoneyCell tiyin={order.priceTiyin} />,
            },
            {
              key: 'discount',
              label: t('admin.orders.detail.discount'),
              value: <MoneyCell tiyin={order.discountTiyin} />,
            },
            {
              key: 'total',
              label: t('admin.orders.detail.total'),
              value: <MoneyCell tiyin={order.totalTiyin} />,
            },
            {
              key: 'cost',
              label: t('admin.orders.col.cost'),
              value: formatCost(order.costCurrency, order.costMinor),
            },
            {
              key: 'rate',
              label: t('admin.orders.detail.rate'),
              value: `${order.fxRate.pair} = ${order.fxRate.rate}`,
            },
            {
              key: 'profit',
              label: t('admin.orders.col.profit'),
              value: order.profitTiyin === null ? '—' : <MoneyCell tiyin={order.profitTiyin} />,
            },
            {
              key: 'refunded',
              label: t('admin.orders.detail.refunded'),
              value: <MoneyCell tiyin={order.refundedTiyin} />,
            },
          ]}
        />
      </Panel>
    </div>
  );
}
