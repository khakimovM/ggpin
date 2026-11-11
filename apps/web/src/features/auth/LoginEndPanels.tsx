'use client';

import { Button, Icon, Spinner } from '@repo/ui';
import { Check, CircleX, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Design `state: rejected` (status DENIED: "Bu men emasman" was pressed in the bot). */
export function LoginRejectedPanel({ onRestart }: { onRestart: () => void }) {
  const t = useTranslations('web.login');
  return (
    <>
      <div role="alert" className="flex flex-col items-center gap-3 py-1 text-center">
        <span className="grid size-16 place-items-center rounded-full bg-danger-soft text-danger">
          <Icon icon={CircleX} size={30} />
        </span>
        <span className="text-[17px] leading-6 font-extrabold">{t('rejected.title')}</span>
        <span className="text-sm leading-5 font-medium text-foreground-secondary">
          {t('rejected.hint')}
        </span>
      </div>
      <Button size="lg" glow className="h-14 w-full text-base" onClick={onRestart}>
        <Icon icon={RotateCcw} size={17} />
        {t('restart')}
      </Button>
    </>
  );
}

/** Success: the welcome line while the full navigation to `next` loads. */
export function LoginSuccessPanel({ displayName }: { displayName: string | null }) {
  const t = useTranslations('web.login');
  return (
    <div role="status" className="flex flex-col items-center gap-3 text-center">
      <span className="grid size-[72px] animate-[gg-pop_var(--dur-slower)_var(--ease-spring)_both] place-items-center rounded-full bg-success-soft text-success">
        <Icon icon={Check} size={34} />
      </span>
      <span className="text-lg leading-6 font-extrabold">
        {displayName === null ? t('success.anon') : t('success.title', { name: displayName })}
      </span>
      <span className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground-muted">
        <Spinner size={16} />
        {t('success.redirecting')}
      </span>
    </div>
  );
}
