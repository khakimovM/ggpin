'use client';

import { Icon } from '@repo/ui';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** The transfer rules: exact amount, no rounding or splitting, a changing card, no paying a dead request. */
export function PayRules() {
  const t = useTranslations('pay');
  return (
    <section role="note" className="flex gap-3 rounded-[20px] bg-warning-soft p-4 text-foreground">
      <Icon icon={TriangleAlert} size={20} className="shrink-0 text-warning-text" />
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm leading-5 font-semibold text-pretty">
        <li>{t('warn')}</li>
        <li>{t('cardChanges')}</li>
        <li>{t('noCancelled')}</li>
      </ul>
    </section>
  );
}
