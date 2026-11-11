'use client';

import type { OrderDetail } from '@repo/shared';
import { Timeline } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatTime } from '../../lib/format/date';
import { buildSteps } from './order-timeline';

/**
 * "Buyurtma holati": the steps of one order, with the times the server recorded. `roomy` (the web
 * store, from 768 px) draws the large steps of Store.dc.html.
 */
export function OrderTimeline({ order, roomy = false }: { order: OrderDetail; roomy?: boolean }) {
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
    <section
      className={`rounded-[24px] border border-border bg-card ${roomy ? 'px-6 pt-6 pb-2' : 'px-4 pt-4 pb-1'}`}
    >
      <Timeline
        size={roomy ? 'lg' : 'md'}
        items={items}
        ariaLabel={t('label')}
        currentLabel={t('current')}
        stateLabels={{ done: t('done'), active: t('active'), pending: t('pending') }}
      />
    </section>
  );
}
