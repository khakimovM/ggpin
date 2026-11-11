'use client';

import { Avatar, Button, Icon } from '@repo/ui';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { telegramPhotoSrc } from './photo-src';
import type { FoundRecipient } from './recipient-machine';

export interface RecipientConfirmedProps {
  recipient: FoundRecipient;
  username: string;
  onChange: () => void;
}

/** Confirmed: the one state in which the page may ask for a price. */
export function RecipientConfirmed({ recipient, username, onChange }: RecipientConfirmedProps) {
  const t = useTranslations('store.product.recipient');
  return (
    <div className="flex items-center gap-3 rounded-[18px] border-[1.5px] border-border bg-background p-3">
      <Avatar
        name={recipient.displayName}
        src={telegramPhotoSrc(recipient.photoUrl)}
        size={48}
        badge={
          <span
            role="img"
            aria-label={t('confirmed')}
            className="absolute -right-0.5 -bottom-0.5 grid size-[18px] place-items-center rounded-full border-2 border-card bg-success text-card"
          >
            <Icon icon={Check} size={10} />
          </span>
        }
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] leading-5 font-extrabold">
          {recipient.displayName}
        </span>
        <span className="truncate text-xs leading-4 font-semibold text-foreground-muted">
          @{username}
        </span>
      </span>
      <Button variant="link" size="sm" onClick={onChange}>
        {t('change')}
      </Button>
    </div>
  );
}
