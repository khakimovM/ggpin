'use client';

import { Button, Icon } from '@repo/ui';
import { CircleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  running: boolean;
  /** Another end request is running; the button waits for it. */
  disabled: boolean;
  failed: boolean;
  onEnd: () => void;
}

/** "Boshqa barcha sessiyalarni yakunlash" (Store.dc.html): the danger-soft bar under the list. */
export function EndOtherSessions({ running, disabled, failed, onEnd }: Props) {
  const t = useTranslations('web.sessions');
  const common = useTranslations('common');
  return (
    <>
      {failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 text-[13px] leading-[18px] font-bold text-danger-text"
        >
          <span className="flex items-center gap-2">
            <Icon icon={CircleAlert} size={15} />
            {t('endAllError')}
          </span>
          <Button variant="outline" size="sm" disabled={disabled || running} onClick={onEnd}>
            {common('retry')}
          </Button>
        </div>
      ) : null}
      <Button
        variant="ghost"
        className="h-11 w-full rounded-control bg-danger-soft text-sm font-extrabold text-danger-text hover:bg-danger-soft hover:text-danger-text"
        loading={running}
        disabled={disabled}
        onClick={onEnd}
      >
        {t('endAll')}
      </Button>
    </>
  );
}
