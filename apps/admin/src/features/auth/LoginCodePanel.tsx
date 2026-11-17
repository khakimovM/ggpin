import { OTP_LENGTH } from '@repo/shared';
import { Button, Icon, OtpInput } from '@repo/ui';
import { CircleCheck, CircleX, RotateCcw, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { formatCountdown } from '../../lib/format';
import { useCountdown } from '../../lib/use-countdown';
import { botHandleOf, type LoginPhase } from './login-machine';
import { LoginProblemBanner } from './LoginProblemBanner';

type CodePhase = Extract<LoginPhase, { name: 'code' }>;

interface Props {
  phase: CodePhase;
  onSubmit: (code: string) => void;
  onEdited: () => void;
  onElapsed: () => void;
  /** "Yangi kod olish": the login begins again with a new nonce (the API has no resend). */
  onRestart: () => void;
}

/** Design `state`: code and wrong (red boxes, attempts left), plus the verifying button. */
export function LoginCodePanel({ phase, onSubmit, onEdited, onElapsed, onRestart }: Props) {
  const t = useTranslations();
  const [code, setCode] = useState('');
  const left = useCountdown(phase.deadline);
  const rateLimited =
    useCountdown(phase.problem?.kind === 'rateLimited' ? phase.problem.until : null) > 0;

  useEffect(() => {
    if (left === 0) onElapsed();
  }, [left, onElapsed]);

  const change = (next: string) => {
    setCode(next);
    onEdited();
  };

  return (
    <>
      <div className="flex items-center justify-center gap-2 text-sm leading-5 font-bold text-success-text">
        <Icon icon={CircleCheck} size={17} />
        {t('admin.login.codeSent')}
      </div>
      <div className="flex flex-col gap-2.5">
        <p className="m-0 text-center text-[13px] leading-[18px] font-bold text-foreground-secondary">
          {t('admin.login.codeLabel', { bot: botHandleOf(phase.botUrl) })}
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
                {t('admin.login.attemptsLeft', { count: phase.wrong.attemptsLeft })}
              </span>
            )
          }
          label={t('admin.login.codeGroup')}
          boxLabel={(position) => t('admin.login.codeBox', { position })}
        />
        {phase.problem === null ? null : <LoginProblemBanner problem={phase.problem} step="code" />}
        <div className="flex items-center justify-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground-muted tabular-nums">
          <Icon icon={Timer} size={14} />
          {t('admin.login.timer', { time: formatCountdown(left) })}
        </div>
      </div>
      <Button
        className="h-14 w-full rounded-tile text-base font-extrabold"
        loading={phase.verifying}
        disabled={code.length !== OTP_LENGTH || rateLimited}
        onClick={() => onSubmit(code)}
      >
        {phase.verifying ? t('admin.login.verifying') : t('admin.login.verify')}
      </Button>
      <Button
        variant="ghost"
        className="self-center"
        disabled={phase.verifying}
        onClick={onRestart}
      >
        <Icon icon={RotateCcw} size={15} />
        {t('admin.login.newCode')}
      </Button>
    </>
  );
}
