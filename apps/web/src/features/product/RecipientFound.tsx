'use client';

import { Avatar, Button } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { telegramPhotoSrc } from './photo-src';
import type { FoundRecipient } from './recipient-machine';

export interface RecipientFoundProps {
  recipient: FoundRecipient;
  username: string;
  onChange: () => void;
  onConfirm: () => void;
}

/** The server found someone: the visitor must say it is the right person (invariant 8). */
export function RecipientFound({ recipient, username, onChange, onConfirm }: RecipientFoundProps) {
  const t = useTranslations('store.product.recipient');
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border-[1.5px] border-primary bg-primary-soft p-3.5">
      <div className="flex items-center gap-3">
        <Avatar name={recipient.displayName} src={telegramPhotoSrc(recipient.photoUrl)} size={48} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base leading-[21px] font-extrabold">
            {recipient.displayName}
          </span>
          <span className="truncate text-[13px] leading-[18px] font-semibold text-foreground-secondary">
            @{username}
          </span>
        </span>
      </div>
      <p className="m-0 text-sm leading-5 font-bold">{t('prompt')}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onChange}>
          {t('change')}
        </Button>
        <Button onClick={onConfirm}>{t('confirm')}</Button>
      </div>
    </div>
  );
}
