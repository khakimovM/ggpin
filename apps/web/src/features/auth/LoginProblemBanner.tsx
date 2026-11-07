'use client';

import { Icon } from '@repo/ui';
import { CircleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '../../lib/format/use-date-format';
import type { LoginProblem } from './login-machine';
import { useCountdown } from './use-countdown';

/** Milliseconds until a rate-limited step may be tried again; 0 for every other problem. */
export function useProblemWait(problem: LoginProblem | null): number {
  return useCountdown(problem?.kind === 'rateLimited' ? problem.until : null);
}

interface Props {
  problem: LoginProblem;
  /** From `useProblemWait`, so the parent can disable its button for the same period. */
  waitMs: number;
  /** In the code step the problem is about the verification, not about opening Telegram. */
  step: 'start' | 'code';
}

export function LoginProblemBanner({ problem, waitMs, step }: Props) {
  const t = useTranslations('web.login.error');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const { countdown } = useDateFormat();

  let title: string;
  let hint: string | null = null;
  switch (problem.kind) {
    case 'rateLimited':
      // Once the wait is over the banner has nothing left to say.
      if (waitMs <= 0) return null;
      title = t('rateLimited', { time: countdown(waitMs) });
      break;
    case 'blocked':
      title = errors('USER_BLOCKED');
      break;
    case 'network':
      title = common('error.network');
      break;
    case 'generic':
      title = step === 'code' ? t('verifyFailed') : t('title');
      hint = step === 'code' ? null : t('hint');
      break;
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-sm leading-5 font-bold text-danger-text"
    >
      <Icon icon={CircleAlert} size={18} className="mt-px shrink-0" />
      <span className="flex flex-col gap-0.5">
        {title}
        {hint === null ? null : (
          <span className="font-medium text-foreground-secondary">{hint}</span>
        )}
      </span>
    </div>
  );
}
