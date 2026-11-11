'use client';

import { Button, EmptyState, ErrorState, Icon } from '@repo/ui';
import { PackageX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { localizedPath } from '../../i18n/paths';
import { isApiError } from '../../lib/api/errors';
import { OrderSkeleton } from './OrderSkeleton';
import { OrderStatusView } from './OrderStatusView';
import { useOrder } from './use-order';

export interface OrderScreenProps {
  variant: 'tg' | 'web';
  id: string;
}

function isMissing(error: unknown): boolean {
  return isApiError(error) && (error.code === 'NOT_FOUND' || error.status === 404);
}

/**
 * The order page of the Mini App and of the web store: skeleton, an error with a retry, "not found"
 * (an id that is not the visitor's looks exactly like one that does not exist) and the order.
 */
export function OrderScreen({ variant, id }: OrderScreenProps) {
  const t = useTranslations('store.order');
  const common = useTranslations('common');
  const locale = useLocale();
  const query = useOrder(id);
  const web = variant === 'web';
  const homeHref = web ? localizedPath(locale, '/store') : '/tg';
  const productBase = web ? localizedPath(locale, '/store/products') : '/tg/products';
  const order = query.data;

  let body;
  if (query.isPending) {
    body = <OrderSkeleton label={t('loading')} />;
  } else if (order !== undefined) {
    body = (
      <OrderStatusView
        order={order}
        homeHref={homeHref}
        productHref={`${productBase}/${order.productSlug}`}
        web={web ? { historyHref: localizedPath(locale, '/store/orders') } : undefined}
      />
    );
  } else if (isMissing(query.error)) {
    body = (
      <EmptyState
        icon={<Icon icon={PackageX} size={24} />}
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          <Button asChild variant="secondary">
            <Link href={homeHref}>{t('actions.home')}</Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <ErrorState
        title={t('error.title')}
        description={t('error.body')}
        retryLabel={common('retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return web ? (
    <main className="mx-auto w-full max-w-[1264px] flex-1 px-4 pt-6 pb-10 md:px-6 md:pt-8 lg:px-8">
      {body}
    </main>
  ) : (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 bg-background px-4 pt-[max(12px,var(--tg-safe-top,0px))] pb-[max(32px,var(--tg-safe-bottom,0px))] text-foreground">
      {body}
    </main>
  );
}
