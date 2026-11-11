'use client';

import { Button, Icon } from '@repo/ui';
import { Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { LoginProblem } from './login-machine';
import { LoginProblemBanner, useProblemWait } from './LoginProblemBanner';

interface Props {
  starting: boolean;
  problem: LoginProblem | null;
  onStart: () => void;
}

/** Design `state`: start, loading and error (the banner above the same button). */
export function LoginStartPanel({ starting, problem, onStart }: Props) {
  const t = useTranslations('web.login');
  const waitMs = useProblemWait(problem);
  return (
    <>
      {problem === null ? null : (
        <LoginProblemBanner problem={problem} waitMs={waitMs} step="start" />
      )}
      <Button
        size="lg"
        glow
        className="h-14 w-full text-base"
        loading={starting}
        disabled={waitMs > 0}
        onClick={onStart}
      >
        {starting ? null : <Icon icon={Send} size={19} />}
        {starting ? t('starting') : t('start')}
      </Button>
    </>
  );
}
