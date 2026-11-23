import { Drawer, Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { getReview } from '../../lib/api/reads';
import { useDrawerParam } from '../../lib/drawer-param';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Tag } from '../common/Tag';
import { BankMessageView } from './BankMessageView';
import { ReviewActions } from './ReviewActions';
import { camelKey } from '../../lib/camel-key';

/** A payment review (`?review=<id>`): why the money was not credited, and the bank message. */
export function ReviewDrawer() {
  const t = useTranslations();
  const { id, close } = useDrawerParam('review');
  const query = useQuery({
    queryKey: qk.payments.review(id ?? ''),
    queryFn: ({ signal }) => getReview(id ?? '', signal),
    enabled: id !== null,
  });
  const review = query.data;
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('admin.payments.review.title')}
      badge={
        review ? (
          <Tag tone={review.status === 'OPEN' ? 'warn' : 'ok'}>
            {t(`admin.payments.reviewStatus.${review.status}`)}
          </Tag>
        ) : null
      }
      closeLabel={t('admin.dialogs.close')}
    >
      {review ? (
        <>
          <p className="m-0 text-[13px] leading-[18px] font-bold">
            {t(`admin.payments.reviewKind.${camelKey(review.kind)}`)}
          </p>
          <KeyValues
            rows={[
              {
                key: 'amount',
                label: t('admin.payments.col.amount'),
                value: review.amountTiyin ? <MoneyCell tiyin={review.amountTiyin} /> : '—',
              },
              {
                key: 'card',
                label: t('admin.payments.col.card'),
                value: review.card ? `${review.card.bank} •${review.card.last4}` : '—',
              },
              {
                key: 'intent',
                label: t('admin.payments.col.intent'),
                value: review.intentId ?? '—',
              },
              {
                key: 'created',
                label: t('admin.payments.col.date'),
                value: formatDateTime(review.createdAt),
              },
              {
                key: 'resolution',
                label: t('admin.payments.review.resolution'),
                value: review.resolution
                  ? t(`admin.payments.reviewResolution.${camelKey(review.resolution)}`)
                  : '—',
              },
              ...(review.note
                ? [{ key: 'note', label: t('admin.payments.review.note'), value: review.note }]
                : []),
            ]}
          />
          {review.status === 'OPEN' ? <ReviewActions review={review} /> : null}
          <h3 className="m-0 border-t border-border pt-3 text-sm leading-[18px] font-extrabold">
            {t('admin.payments.message.title')}
          </h3>
          <BankMessageView message={review.bankMessage} />
        </>
      ) : query.isError ? (
        <LoadError
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-2">
          <Skeleton className="h-40 rounded-[10px]" />
          <Skeleton className="h-48 rounded-[10px]" />
        </div>
      )}
    </Drawer>
  );
}
