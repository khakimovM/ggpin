'use client';

import type { OrderDetail } from '@repo/shared';
import { Timeline } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatTime } from '../../lib/format/date';
import { buildSteps } from './order-timeline';

/** "Buyurtma holati": the steps of one order, with the times the server recorded. */
export function OrderTimeline({ order }: { order: OrderDetail }) {
  const t = useTranslations('store.order.timeline');
  const locale = useLocale();
  const items = buildSteps(order).map((step) => ({
    id: step.id,
    state: step.state,
    tone: step.tone,
    title: t(step.id),
    description: step.at === null ? undefined : formatTime(new Date(step.at), { locale }),
  }));
  return (
    <section className="rounded-[24px] border border-border bg-card px-4 pt-4 pb-1">
      <Timeline
        items={items}
        ariaLabel={t('label')}
        currentLabel={t('current')}
        stateLabels={{ done: t('done'), active: t('active'), pending: t('pending') }}
      />
    </section>
  );
}
