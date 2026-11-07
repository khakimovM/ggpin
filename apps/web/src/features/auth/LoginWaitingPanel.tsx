'use client';

import { Button, Icon, Spinner, cn } from '@repo/ui';
import { Check, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  /** `botUrl` of the start response: the only source of the bot link. */
  botUrl: string;
  onCancel: () => void;
}

type StepState = 'done' | 'current' | 'todo';

function Step({ state, index, children }: { state: StepState; index: number; children: string }) {
  return (
    <li
      className={cn(
        'flex items-start gap-3 text-[15px] leading-[22px]',
        state === 'done' && 'font-semibold',
        state === 'current' && 'font-bold',
        state === 'todo' && 'font-semibold text-foreground-secondary',
      )}
      aria-current={state === 'current' ? 'step' : undefined}
    >
      <span
        className={cn(
          'grid size-7 flex-none place-items-center rounded-full text-xs font-extrabold',
          state === 'done' && 'bg-success text-card',
          state === 'current' &&
            'bg-primary-soft text-primary-soft-foreground ring-[1.5px] ring-primary',
          state === 'todo' && 'bg-muted text-foreground-muted',
        )}
      >
        {state === 'done' ? <Icon icon={Check} size={14} /> : index}
      </span>
      <span className="pt-[3px]">{children}</span>
    </li>
  );
}

export function LoginWaitingPanel({ botUrl, onCancel }: Props) {
  const t = useTranslations('web.login');
  return (
    <>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        <Step state="done" index={1}>
          {t('steps.open')}
        </Step>
        <Step state="current" index={2}>
          {t('steps.start')}
        </Step>
        <Step state="todo" index={3}>
          {t('steps.enter')}
        </Step>
      </ol>
      <Button asChild variant="outline" size="lg" className="w-full text-[15px]">
        <a href={botUrl} target="_blank" rel="noopener noreferrer">
          <Icon icon={ExternalLink} size={17} />
          {t('openTelegram')}
        </a>
      </Button>
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 text-sm leading-5 font-semibold text-info-text"
      >
        <Spinner size={16} />
        {t('waiting')}
      </div>
      <Button variant="ghost" size="sm" className="self-center text-[13px]" onClick={onCancel}>
        {t('cancel')}
      </Button>
    </>
  );
}
