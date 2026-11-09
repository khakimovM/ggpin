'use client';

import { Button, Icon } from '@repo/ui';
import { Hourglass } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SupportLinkButton } from '../support/SupportLinkButton';

/**
 * "To'ldirish vaqtincha mavjud emas" (TopupMini.dc.html): no card has room, or the bank-message
 * listener is down. Calm, no blame: a retry and the way to support.
 */
export function TopupUnavailable({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations('store.topup');
  return (
    <section
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <span
        aria-hidden="true"
        className="grid size-20 place-items-center rounded-full bg-muted text-foreground-secondary"
      >
        <Icon icon={Hourglass} size={34} />
      </span>
      <h2 className="m-0 mt-2 max-w-[360px] text-2xl leading-[30px] font-extrabold text-balance">
        {t('unavailable.title')}
      </h2>
      <p className="m-0 max-w-[340px] text-[15px] leading-[22px] font-medium text-foreground-secondary text-pretty">
        {t('unavailable.body')}
      </p>
      <div className="mt-3 flex w-full max-w-[360px] flex-col gap-1.5">
        <Button size="lg" loading={retrying} onClick={onRetry} className="w-full">
          {t('unavailable.retry')}
        </Button>
        <SupportLinkButton variant="ghost" className="w-full" fallbackToBot>
          {t('unavailable.support')}
        </SupportLinkButton>
      </div>
    </section>
  );
}
