'use client';

import { Button, Icon } from '@repo/ui';
import { Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useHydrated } from '../../lib/use-hydrated';
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
  // Owner decision (p8 S6): before hydration a click on the button was silently lost, so until
  // then it is shown disabled and busy (the Button's existing disabled look, no new state).
  const hydrated = useHydrated();
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
        disabled={!hydrated || waitMs > 0}
        // Passed only before hydration: an explicit undefined would override the Button's own
        // aria-busy of the `loading` state.
        {...(hydrated ? {} : { 'aria-busy': true })}
        onClick={onStart}
      >
        {starting ? null : <Icon icon={Send} size={19} />}
        {starting ? t('starting') : t('start')}
      </Button>
    </>
  );
}
