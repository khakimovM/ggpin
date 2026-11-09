'use client';

import { Icon } from '@repo/ui';
import { ShieldAlert, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * What a payer who got this link from someone else must see BEFORE sending money (D-37 (7), docs/04
 * "Frontend talablari"): whose account it tops up (`ownerHint`, "S***r") and that it is only for
 * one's own account. The design has no such block, so it uses the design's own warning note.
 */
export function PayOwnerNote({ ownerHint }: { ownerHint: string | null }) {
  const t = useTranslations('pay');
  return (
    <section
      role="note"
      className="flex gap-3 rounded-[20px] border border-warning bg-warning-soft p-4 text-foreground"
    >
      <Icon icon={ShieldAlert} size={20} className="shrink-0 text-warning-text" />
      <div className="flex min-w-0 flex-col gap-1">
        {ownerHint === null ? null : (
          <span
            data-testid="pay-owner"
            className="flex items-center gap-1.5 text-sm leading-5 font-extrabold"
          >
            <Icon icon={UserRound} size={15} />
            {t('owner', { hint: ownerHint })}
          </span>
        )}
        <span className="text-sm leading-5 font-semibold text-pretty">{t('foreign')}</span>
      </div>
    </section>
  );
}
