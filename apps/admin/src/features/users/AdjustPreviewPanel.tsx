import type { AdminAdjustPreview } from '@repo/shared';
import { Button, Skeleton, cn } from '@repo/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { formatDateTime } from '../../lib/format';
import { CheckField } from '../common/CheckField';
import { MoneyCell } from '../common/MoneyCell';
import { OrderStatusTag } from '../common/OrderStatusTag';

interface Props {
  preview: AdminAdjustPreview | undefined;
  /** No valid amount yet: nothing to preview. */
  idle: boolean;
  error: string | null;
  onRetry: () => void;
  recentConfirmed: boolean;
  onRecentConfirmed: (value: boolean) => void;
  openOrdersConfirmed: boolean;
  onOpenOrdersConfirmed: (value: boolean) => void;
  disabled?: boolean;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3">
      <span className="text-xs leading-4 font-extrabold">{title}</span>
      {children}
    </div>
  );
}

/**
 * What the adjustment would meet, from `GET /admin/users/:id/adjust-preview` (server values only:
 * the new balance is the API's, never a sum made here). Recent automatic top-ups and open orders
 * must be ticked: their set ids go into the body and the code binding (S9 F-L1, I-5).
 */
export function AdjustPreviewPanel(props: Props) {
  const t = useTranslations();
  const { preview } = props;
  if (props.idle) return null;
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 rounded-sm bg-danger-soft px-3 py-2 text-xs leading-4 font-bold text-danger-text"
      >
        <span className="min-w-0 flex-1">{props.error}</span>
        <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
          {t('admin.states.retry')}
        </Button>
      </div>
    );
  }
  if (preview === undefined) {
    return (
      <div role="status" aria-label={t('admin.states.loading')}>
        <Skeleton className="h-12 rounded-sm" />
      </div>
    );
  }
  const negative = preview.newBalanceTiyin.startsWith('-');
  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-1.5 text-xs leading-4 font-bold tabular-nums">
        <span className="text-foreground-muted">{t('admin.users.adjust.current')}</span>
        <MoneyCell tiyin={preview.balanceTiyin} />
        <span aria-hidden="true">→</span>
        <span className="text-foreground-muted">{t('admin.users.adjust.newBalance')}</span>
        <MoneyCell tiyin={preview.newBalanceTiyin} className={cn(negative && 'text-danger-text')} />
      </span>
      {preview.otpReason === 'CREDIT' ? (
        <span className="text-[11px] leading-[15px] font-semibold text-foreground-muted">
          {t('admin.users.adjust.codeAlways')}
        </span>
      ) : null}
      <span className="text-[11px] leading-[15px] font-semibold text-foreground-muted tabular-nums">
        {t('admin.users.adjust.manualToday')}{' '}
        <MoneyCell tiyin={preview.manualCreditToday.usedTiyin} bare /> /{' '}
        <MoneyCell tiyin={preview.manualCreditToday.capTiyin} />
      </span>
      {preview.recentAutoTopups.length > 0 ? (
        <Block title={t('admin.users.adjust.recentTitle')}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs leading-4 tabular-nums">
            {preview.recentAutoTopups.map((topup) => (
              <li key={topup.paymentId} className="flex justify-between gap-2">
                <span className="text-foreground-secondary">
                  {formatDateTime(topup.confirmedAt)}
                </span>
                <MoneyCell tiyin={topup.amountTiyin} className="font-extrabold" />
              </li>
            ))}
          </ul>
          <CheckField
            label={t('admin.users.adjust.recentConfirm')}
            checked={props.recentConfirmed}
            onChange={props.onRecentConfirmed}
            disabled={props.disabled}
          />
        </Block>
      ) : null}
      {preview.openOrders.length > 0 ? (
        <Block title={t('admin.users.adjust.openOrdersTitle')}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs leading-4 tabular-nums">
            {preview.openOrders.map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-extrabold">
                  #{order.number}
                  <OrderStatusTag status={order.status} />
                </span>
                <MoneyCell tiyin={order.priceTiyin} />
              </li>
            ))}
          </ul>
          <CheckField
            label={t('admin.users.adjust.openOrdersConfirm')}
            checked={props.openOrdersConfirmed}
            onChange={props.onOpenOrdersConfirmed}
            disabled={props.disabled}
          />
        </Block>
      ) : null}
    </div>
  );
}
