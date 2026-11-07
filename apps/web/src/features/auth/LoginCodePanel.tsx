'use client';

import { OTP_LENGTH } from '@repo/shared';
import { Button, Icon, OtpInput } from '@repo/ui';
import { CircleCheck, CircleX, RefreshCw, RotateCcw, Timer, TimerOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { env } from '../../env';
import { useDateFormat } from '../../lib/format/use-date-format';
import type { LoginPhase } from './login-machine';
import { LoginProblemBanner, useProblemWait } from './LoginProblemBanner';
import { useCountdown } from './use-countdown';

type CodePhase = Extract<LoginPhase, { name: 'code' }>;

interface CodeProps {
  phase: CodePhase;
  onSubmit: (code: string) => void;
  onEdited: () => void;
  onElapsed: () => void;
  /** "Yangi kod olish": the login begins again with a new nonce (the API has no resend). */
  onRestart: () => void;
}

/** Design `state`: code and wrong (the red boxes), plus the verifying button. */
export function LoginCodePanel({ phase, onSubmit, onEdited, onElapsed, onRestart }: CodeProps) {
  const t = useTranslations('web.login');
  const { countdown } = useDateFormat();
  const [code, setCode] = useState('');
  const left = useCountdown(phase.deadline);
  const waitMs = useProblemWait(phase.problem);

  // The deadline is a timestamp: crossing it ends the step, even after a long sleep.
  useEffect(() => {
    if (left === 0) onElapsed();
  }, [left, onElapsed]);

  const full = code.length === OTP_LENGTH;
  const change = (next: string) => {
    setCode(next);
    onEdited();
  };

  return (
    <>
      <div className="flex items-center justify-center gap-2 text-sm leading-5 font-bold text-success-text">
        <Icon icon={CircleCheck} size={17} />
        {t('codeSent')}
      </div>
      <div className="flex flex-col gap-2.5">
        <p className="m-0 text-center text-[13px] leading-[18px] font-bold text-foreground-secondary">
          {t('codeLabel', { bot: `@${env.NEXT_PUBLIC_BOT_USERNAME}` })}
        </p>
        <OtpInput
          value={code}
          onChange={change}
          onComplete={onSubmit}
          length={OTP_LENGTH}
          autoFocus
          error={phase.wrong !== null}
          errorKey={phase.wrong?.shake}
          errorMessage={
            phase.wrong === null ? null : (
              <span className="inline-flex items-center justify-center gap-1.5">
                <Icon icon={CircleX} size={15} />
                {t('attemptsLeft', { count: phase.wrong.attemptsLeft })}
              </span>
            )
          }
          label={t('codeGroup')}
          boxLabel={(position) => t('codeBox', { position })}
        />
        {phase.problem === null ? null : (
          <LoginProblemBanner problem={phase.problem} waitMs={waitMs} step="code" />
        )}
        <div className="flex items-center justify-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground-muted tabular-nums">
          <Icon icon={Timer} size={14} />
          {t('timer', { time: countdown(left) })}
        </div>
      </div>
      <Button
        size="lg"
        className="h-14 w-full text-base"
        loading={phase.verifying}
        disabled={!full || waitMs > 0}
        onClick={() => onSubmit(code)}
      >
        {phase.verifying ? t('verifying') : t('verify')}
      </Button>
      <Button
        variant="ghost"
        className="self-center text-sm text-primary-soft-foreground"
        disabled={phase.verifying}
        onClick={onRestart}
      >
        <Icon icon={RotateCcw} size={15} />
        {t('newCode')}
      </Button>
    </>
  );
}

/** Design `state: expired`: dimmed empty boxes, the message and a new-code button. */
export function LoginExpiredPanel({ onRestart }: { onRestart: () => void }) {
  const t = useTranslations('web.login');
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <OtpInput
          value=""
          onChange={() => undefined}
          length={OTP_LENGTH}
          disabled
          label={t('codeGroup')}
          boxLabel={(position) => t('codeBox', { position })}
        />
        <div
          role="alert"
          className="flex items-center justify-center gap-1.5 text-[13px] leading-[18px] font-bold text-warning-text"
        >
          <Icon icon={TimerOff} size={15} />
          {t('expired')}
        </div>
      </div>
      <Button size="lg" glow className="h-14 w-full text-base" onClick={onRestart}>
        <Icon icon={RefreshCw} size={17} />
        {t('newCode')}
      </Button>
    </>
  );
}
