import type { AdminCardListResponse, TopupCardStatus } from '@repo/shared';
import { Skeleton, cn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listCards } from '../../lib/api/reads';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Tag, type TagTone } from '../common/Tag';

type Card = AdminCardListResponse[number];

const TONE: Record<TopupCardStatus, TagTone> = {
  VERIFYING: 'info',
  ACTIVE: 'ok',
  FULL: 'warn',
  DRAINING: 'warn',
  RETIRED: 'mute',
};

function CardTile({ card }: { card: Card }) {
  const t = useTranslations();
  // usagePercent comes from the API (received / limit); the bar only draws it.
  const width = Math.min(100, Math.max(0, card.usagePercent));
  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-[10px] bg-primary-soft text-primary-soft-foreground">
          <CreditCard size={18} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm leading-[18px] font-extrabold tabular-nums">
            {card.bank} •{card.last4}
          </span>
          <span className="truncate text-[11px] leading-[14px] font-semibold text-foreground-muted">
            {card.holderName}
          </span>
        </span>
        <span className="ml-auto flex gap-1">
          {card.autoCreditPaused ? <Tag tone="bad">{t('admin.payments.cards.paused')}</Tag> : null}
          <Tag tone={TONE[card.status]}>{card.status}</Tag>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex justify-between text-xs leading-4 font-bold tabular-nums">
          <span className="text-foreground-muted">{t('admin.payments.cards.usage')}</span>
          <span>{card.usagePercent}%</span>
        </span>
        <span className="h-2 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full', width >= 80 ? 'bg-warning' : 'bg-primary')}
            style={{ width: `${width}%` }}
          />
        </span>
      </div>
      <KeyValues
        rows={[
          {
            key: 'received',
            label: t('admin.payments.cards.received'),
            value: <MoneyCell tiyin={card.receivedTiyin} />,
          },
          {
            key: 'limit',
            label: t('admin.payments.cards.limit'),
            value: <MoneyCell tiyin={card.receiveLimitTiyin} />,
          },
          {
            key: 'month',
            label: t('admin.payments.cards.month'),
            value: <MoneyCell tiyin={card.receivedMonthTiyin} />,
          },
          {
            key: 'monthLimit',
            label: t('admin.payments.cards.monthLimit'),
            value: card.monthlyLimitTiyin ? <MoneyCell tiyin={card.monthlyLimitTiyin} /> : '—',
          },
          {
            key: 'reserved',
            label: t('admin.payments.cards.reserved'),
            value: <MoneyCell tiyin={card.reservedTiyin} />,
          },
          {
            key: 'verified',
            label: t('admin.payments.cards.verified'),
            value: card.verifiedAt ? formatDateTime(card.verifiedAt) : '—',
          },
        ]}
      />
    </article>
  );
}

/** Our receiving cards (Humo / Uzcard): status, limits and how full each one is. */
export function CardsTab() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.payments.cards(),
    queryFn: ({ signal }) => listCards(signal),
  });
  if (query.data && query.data.length > 0) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {query.data.map((card) => (
          <CardTile key={card.id} card={card} />
        ))}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card py-6">
      {query.data ? (
        <ListEmpty
          icon={CreditCard}
          title={t('admin.payments.empty.cards')}
          description={t('admin.payments.cards.emptyHint')}
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
          className="grid gap-3 px-3.5 lg:grid-cols-2"
        >
          <Skeleton className="h-56 rounded-md" />
          <Skeleton className="h-56 rounded-md" />
        </div>
      )}
    </div>
  );
}
