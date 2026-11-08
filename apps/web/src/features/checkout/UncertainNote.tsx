'use client';

import { Icon } from '@repo/ui';
import { CircleHelp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SupportLinkButton } from '../support/SupportLinkButton';

export interface UncertainNoteProps {
  /** The purchase in doubt: product and variant as the visitor saw them, no amount. */
  label?: string;
  /** Why the last check was refused (a 400, a 429...), when it was. */
  message?: string;
}

/**
 * The answer to "To‘lash" never came: the order may exist and the money may be gone. It says which
 * purchase it is, says so plainly, promises that asking again cannot charge twice (the same key is
 * sent) and leads to support. The order list does not exist yet (S9 adds a link to it here).
 */
export function UncertainNote({ label, message }: UncertainNoteProps) {
  const t = useTranslations('store.checkout.uncertain');
  return (
    <div
      role="alert"
      data-uncertain=""
      className="flex flex-col gap-3 rounded-2xl bg-warning-soft p-3.5 text-warning-text"
    >
      <span className="flex items-center gap-2 text-[15px] leading-5 font-extrabold">
        <Icon icon={CircleHelp} size={17} />
        {t('title')}
      </span>
      {label ? (
        <span className="text-[13px] leading-[18px] font-bold break-words text-foreground">
          {t('item', { item: label })}
        </span>
      ) : null}
      <span className="text-[13px] leading-[18px] font-semibold text-foreground-secondary">
        {t('body')}
      </span>
      {message ? (
        <span className="text-[13px] leading-[18px] font-bold text-danger-text">{message}</span>
      ) : null}
      <SupportLinkButton variant="secondary" className="w-full">
        {t('support')}
      </SupportLinkButton>
    </div>
  );
}
