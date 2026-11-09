'use client';

import { Icon } from '@repo/ui';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * What the visitor must read before sending money, repeated inside the Mini App although the card
 * is on the pay page (docs/04 "Frontend talablari" 7, D-37 (7)): the exact amount, a card that
 * changes, one's own account, and no money for a cancelled request. The design's own warning note.
 */
export function TopupNotes() {
  const t = useTranslations('tg.topup.notes');
  return (
    <section role="note" className="flex gap-3 rounded-[20px] bg-warning-soft p-4 text-foreground">
      <Icon icon={TriangleAlert} size={20} className="shrink-0 text-warning-text" />
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm leading-5 font-semibold text-pretty">
        <li>{t('exact')}</li>
        <li>{t('cardChanges')}</li>
        <li>{t('own')}</li>
        <li>{t('noCancelled')}</li>
      </ul>
    </section>
  );
}
